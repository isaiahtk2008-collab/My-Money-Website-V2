# Run with: python3 tests/ui-expiry-banner.py        (needs: pip install playwright && playwright install chromium)
# Checks the expiry banner in a real browser with made-up loans and deposits: it shows, uses the right colours, escapes names, rotates, pauses on hover,
# snooze and dismiss work and are remembered on this device, it never covers the Log entry button (desktop and phone width), the off switch removes it,
# reduced motion makes it instant, and nothing is sent anywhere. Never touches Google or the sheet.
import pathlib, sys, json
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
INIT_CHART = "window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"

# Three open entries (one overdue deposit with a hostile name, one loan due in 2 days, one deposit far off), plus a closed one that must never show.
INJECT = """(()=>{
  const day=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
  const r=store.base||store.raw;
  r.Owed={rows:[
    {_row:2,'Row ID':'D1','Type':'Deposit','Person':'<img src=x onerror=window.__xss=1>','Item / Device':'Pixel 9','Total Amount':500,'Amount Paid':100,'Date Out':day(-10),'Due Date':day(-2),'Status':'Waiting'},
    {_row:3,'Row ID':'L1','Type':'Loan','Person':'Sam','Item / Device':'iPhone','Total Amount':200,'Amount Paid':50,'Date Out':day(-5),'Due Date':day(2),'Status':'Out'},
    {_row:4,'Row ID':'D2','Type':'Deposit','Person':'Far','Item / Device':'PC','Total Amount':900,'Amount Paid':100,'Date Out':day(-1),'Due Date':day(30),'Status':'Waiting'},
    {_row:5,'Row ID':'D3','Type':'Deposit','Person':'Done','Item / Device':'Laptop','Total Amount':700,'Amount Paid':700,'Date Out':day(-9),'Due Date':day(-3),'Status':'Picked Up'}
  ]};
})()"""

def overlaps(a, b):
    return not (a['x'] + a['width'] <= b['x'] or b['x'] + b['width'] <= a['x'] or a['y'] + a['height'] <= b['y'] or b['y'] + b['height'] <= a['y'])

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 800})
    page = ctx.new_page()
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    def route(r):
        if r.request.url.startswith('file:'): r.continue_()
        else:
            requests.append((r.request.method, r.request.url)); r.abort()
    page.route('**/*', route)
    page.add_init_script(INIT_AUTH); page.add_init_script(INIT_CHART)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_function(READY)

    # nothing to show without any loans or deposits
    page.evaluate('window.__mmExpiryCheck()')
    check('no banner when there are no loans or deposits', page.locator('#expiry-banner').count() == 0)

    page.evaluate("localStorage.setItem('mm.expiry', JSON.stringify({speed:3}))")
    page.evaluate(INJECT); page.evaluate('window.__mmExpiryCheck()')
    check('banner appears (on by default) with entries', page.locator('#expiry-banner').count() == 1)
    first = page.locator('#expiry-banner .eb-card')
    check('overdue entry comes first, with the blinking red style', 'eb-overdue' in (first.get_attribute('class') or '') and 'Overdue' in first.inner_text(), first.inner_text())
    check('shows 1 of 2 (closed and far-off entries are left out)', '1 of 2' in first.inner_text(), first.inner_text())
    check('hostile name is shown as plain text, never run', page.evaluate('window.__xss') is None and page.locator('#expiry-banner img').count() == 0 and '<img' in first.inner_text())
    check('region has an accessible label', page.locator('#expiry-banner').get_attribute('aria-label') == 'Deposit and loan deadlines')
    check('overdue card uses the existing blink animation', page.evaluate("getComputedStyle(document.querySelector('.eb-card')).animationName") == 'ss-blink')

    # rotation
    page.wait_for_timeout(4600)
    t = page.locator('#expiry-banner .eb-card').inner_text()
    check('rotates to the next entry (yellow, due soon)', '2 of 2' in t and 'Due soon' in t and 'eb-pending' in (page.locator('#expiry-banner .eb-card').get_attribute('class') or ''), t)
    page.wait_for_timeout(3600)
    check('wraps back to the first entry', '1 of 2' in page.locator('#expiry-banner .eb-card').inner_text())

    # hover pauses rotation
    page.locator('#expiry-banner .eb-card').hover()
    before = page.locator('#expiry-banner .eb-card').inner_text()
    page.wait_for_timeout(4200)
    check('hover pauses the rotation', page.locator('#expiry-banner .eb-card').inner_text() == before)
    page.mouse.move(5, 5)

    # never covers the Log entry button; click-through outside the card
    fab = page.locator('.lg-fab')
    if fab.count():
        fb, bb = fab.bounding_box(), page.locator('#expiry-banner .eb-card').bounding_box()
        check('desktop: does not cover the Log entry button', not overlaps(fb, bb), f'{fb} {bb}')
        check('desktop: the wrapper lets clicks through', page.evaluate("getComputedStyle(document.getElementById('expiry-banner')).pointerEvents") == 'none')
    else:
        check('Log entry button found', False)

    # snooze + dismiss, remembered on this device
    page.locator('[data-eb="snooze"]').click()
    check('snooze hides that entry (1 left)', page.locator('#expiry-banner .eb-card').count() == 1 and '1 of' not in page.locator('#expiry-banner .eb-card').inner_text())
    sn = json.loads(page.evaluate("localStorage.getItem('mm.expiry.snooze')"))
    check('snooze is saved on this device only, as a date', len(sn) == 1 and list(sn.values())[0][:2] == '20')
    page.locator('[data-eb="dismiss"]').click()
    check('dismiss hides the last entry and the banner goes away', page.locator('#expiry-banner').count() == 0)
    sn = json.loads(page.evaluate("localStorage.getItem('mm.expiry.snooze')"))
    check('both entries are remembered as hidden', len(sn) == 2)
    page.evaluate('window.__mmExpiryCheck()')
    check('they stay hidden on the next check', page.locator('#expiry-banner').count() == 0)

    # off switch
    page.mouse.move(600, 300)   # the real pointer was left over the spot where the banner comes back, which would (correctly) pause it
    page.evaluate("localStorage.removeItem('mm.expiry.snooze')"); page.evaluate('window.__mmExpiryCheck()')
    check('entries come back when the snoozes are cleared', page.locator('#expiry-banner').count() == 1)
    page.wait_for_timeout(3800)
    check('rotation still works after the banner was removed while a button had focus (pause is not stuck)', '2 of 2' in page.locator('#expiry-banner .eb-card').inner_text(), page.locator('#expiry-banner .eb-card').inner_text())
    page.evaluate("localStorage.setItem('mm.expiry', JSON.stringify({enabled:false}))"); page.evaluate('window.__mmExpiryCheck()')
    check('turning the setting off removes the banner', page.locator('#expiry-banner').count() == 0)
    page.evaluate("localStorage.setItem('mm.expiry', '{not json')"); page.evaluate('window.__mmExpiryCheck()')
    check('a broken saved setting falls back to on', page.locator('#expiry-banner').count() == 1)

    # threshold setting
    page.evaluate("localStorage.setItem('mm.expiry', JSON.stringify({depDays:0,loanDays:0}))"); page.evaluate('window.__mmExpiryCheck()')
    check('threshold 0 keeps only the overdue entry', '1 of' not in page.locator('#expiry-banner .eb-card').inner_text() and 'Overdue' in page.locator('#expiry-banner .eb-card').inner_text())

    # phone width
    page.evaluate("localStorage.setItem('mm.expiry', JSON.stringify({size:'large'}))"); page.evaluate('window.__mmExpiryCheck()')
    page.set_viewport_size({'width': 390, 'height': 800}); page.wait_for_timeout(300)
    fab = page.locator('.lg-fab')
    bb = page.locator('#expiry-banner .eb-card').bounding_box()
    check('phone: card fits inside the screen width', bb['x'] >= 0 and bb['x'] + bb['width'] <= 390, str(bb))
    check('phone: no sideways scrolling added', page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    if fab.count():
        check('phone: does not cover the Log entry button', not overlaps(fab.bounding_box(), bb), f'{fab.bounding_box()} {bb}')
    page.set_viewport_size({'width': 1100, 'height': 800})

    # reduced motion = instant
    rctx = b.new_context(viewport={'width': 1100, 'height': 800}, reduced_motion='reduce')
    rp = rctx.new_page()
    rp.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    rp.add_init_script(INIT_AUTH); rp.add_init_script(INIT_CHART)
    rp.goto(PAGE.as_uri() + '?demo=1'); rp.wait_for_function(READY)
    rp.evaluate(INJECT); rp.evaluate('window.__mmExpiryCheck()')
    check('reduced motion: no fade time and no blinking', rp.evaluate("(()=>{const c=getComputedStyle(document.querySelector('.eb-card'));return parseFloat(c.transitionDuration)===0&&c.animationName==='none'})()"))
    rctx.close()

    check('nothing was sent anywhere', not [r for r in requests if r[0] != 'GET'], str(requests))
    check('no page errors', not errors, str(errors))
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

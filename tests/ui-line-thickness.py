# Run with: python3 tests/ui-line-thickness.py        (needs: pip install playwright && playwright install chromium)
# Checks the "Line thickness" slider in Settings > Appearance > Fine tuning in a real browser: the row is there once, 100% looks exactly like before
# (1px lines, nothing saved), 0% removes borders on cards / inputs / buttons / the banner, 300% makes them 3px, focus rings are left alone,
# Reset fine tuning and Reset to default restore it, it is saved on this device only, and the phone layout does not overflow.
# Optional: set SHOTS_DIR to also save screenshots (0%, 100%, 300%, desktop + phone). Never touches Google or the sheet.
import os, pathlib
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
SHOTS = os.environ.get('SHOTS_DIR')
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
INIT_AUTH += "try{localStorage.setItem('mm.ap.drawer3','1')}catch(e){}"
INIT_AUTH += "try{localStorage.setItem('mm.setfold',JSON.stringify(['In-App Reminders','Expiry banner','Appearance']))}catch(e){}"   # opens those Settings sections
INIT_CHART = "window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"
BW = "(sel)=>{const e=document.querySelector(sel);if(!e)return null;const c=getComputedStyle(e);return [c.borderTopWidth,c.borderTopStyle]}"
SET = "(v)=>{const s=document.querySelector('#ap3-line');s.value=v;s.dispatchEvent(new Event('input',{bubbles:true}))}"

def new_page(b, w, h, saved=None):
    ctx = b.new_context(viewport={'width': w, 'height': h})
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script(INIT_AUTH); page.add_init_script(INIT_CHART)
    if saved is not None: page.add_init_script("try{localStorage.setItem('mm.hfx.line','%s')}catch(e){}" % saved)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_function(READY)
    return page, errors

with sync_playwright() as p:
    b = p.chromium.launch()
    page, errors = new_page(b, 1100, 800)
    page.click('.logo[data-sec=open]'); page.wait_for_selector('#hfx-card')

    check('Line thickness row exists once', page.locator('#ap3-line').count() == 1 and page.locator('#ap3-line-v').count() == 1)
    check('it sits in Fine tuning, right after Corner roundness', page.evaluate("(()=>{const r=[...document.querySelectorAll('#ap3-drawer .ap3-row input[type=range]')].map(e=>e.id);return r.indexOf('ap3-line')===r.indexOf('ap3-round')+1&&r.indexOf('ap3-round')>=0})()"))
    check('range is 0 to 300 and starts at 100%', page.get_attribute('#ap3-line', 'min') == '0' and page.get_attribute('#ap3-line', 'max') == '300' and page.input_value('#ap3-line') == '100' and page.inner_text('#ap3-line-v') == '100%')
    check('helper text is shown', 'Thinner or thicker borders' in page.inner_text('#ap3-drawer'))
    check('100% sets no gate and no variable', page.evaluate("document.documentElement.hasAttribute('data-ap3-line')||document.documentElement.style.getPropertyValue('--ap3-w')!==''") is False)
    check('100%: nothing is saved', page.evaluate("localStorage.getItem('mm.hfx.line')") is None)
    base = {s: page.evaluate(BW, s) for s in ['.card', '.m3-card', '#hfx-card .hfx-drawer', '#hfx-card .chip-b', '#hfx-card .ap3-tabs']}
    check('100%: lines are the original 1px', all(v and v[0] == '1px' for v in base.values() if v), base)

    page.evaluate(SET, 0)
    check('0% reads None, is saved, applies 0px', page.inner_text('#ap3-line-v') == 'None' and page.evaluate("localStorage.getItem('mm.hfx.line')") == '0' and page.evaluate("document.documentElement.style.getPropertyValue('--ap3-w')") == '0.000px')
    zero = {s: page.evaluate(BW, s) for s in base if base[s]}
    check('0%: cards, drawer and buttons have no border', all(v[0] == '0px' for v in zero.values()), zero)
    page.evaluate(SET, 300)
    three = {s: page.evaluate(BW, s) for s in base if base[s]}
    check('300%: lines are 3px', all(v[0] == '3px' for v in three.values()) and page.inner_text('#ap3-line-v') == '300%', three)
    page.evaluate(SET, 150)
    # browsers draw borders in whole device pixels (1.5px shows as 1px on a 1x screen, 3px on 2x/3x phones), so check the value we set
    check('150%: the line width is set to 1.5px', page.evaluate("document.documentElement.style.getPropertyValue('--ap3-w')") == '1.500px' and page.evaluate(BW, '#hfx-card .hfx-drawer')[0] in ('1px', '1.5px'))

    # focus rings are not scaled away
    page.evaluate(SET, 0)
    page.focus('#ap3-line'); page.keyboard.press('Tab'); page.keyboard.press('Shift+Tab')
    ow = page.evaluate("getComputedStyle(document.activeElement).outlineWidth")
    check('0%: a keyboard-focused control still shows its focus ring', ow not in ('0px', ''), ow)

    # banner preview
    page.evaluate(SET, 300)
    if page.locator('[data-ebs=preview]').count():
        page.evaluate("document.querySelector('[data-ebs=preview]').click()")
        try:
            page.wait_for_selector('#expiry-banner .eb-card', timeout=4000)
            check('300%: the banner card border is 3px too', page.evaluate(BW, '#expiry-banner .eb-card')[0] == '3px')
            page.evaluate(SET, 0)
            check('0%: the banner card has no border', page.evaluate(BW, '#expiry-banner .eb-card')[0] == '0px')
        except Exception as e:
            check('banner preview showed', False, str(e))
    else:
        check('banner preview button found', False)

    # resets
    page.evaluate(SET, 220)
    page.evaluate("document.querySelector('[data-ap3-resetfine]').click()")
    check('Reset fine tuning puts it back to 100% and clears the saved value', page.input_value('#ap3-line') == '100' and page.inner_text('#ap3-line-v') == '100%' and page.evaluate("localStorage.getItem('mm.hfx.line')") is None and page.evaluate(BW, '#hfx-card .hfx-drawer')[0] == '1px')
    page.evaluate(SET, 40)
    page.evaluate("document.querySelector('[data-hfx-reset]').click()")
    check('Reset to default also restores it', page.input_value('#ap3-line') == '100' and page.evaluate("localStorage.getItem('mm.hfx.line')") is None)

    # device only: nothing is sent anywhere (every non-file request is aborted; the sync would try one)
    page.evaluate(SET, 60)
    check('saved value survives in this device\'s storage only', page.evaluate("localStorage.getItem('mm.hfx.line')") == '60')
    check('no page errors', not errors, errors)
    page.context.close()

    # reload keeps the choice; bad stored values are ignored
    page, errors = new_page(b, 1100, 800, saved='200')
    check('a saved 200% is applied on load, before anything is opened', page.evaluate("document.documentElement.style.getPropertyValue('--ap3-w')") == '2.000px' and page.evaluate(BW, '.card')[0] == '2px')
    page.context.close()
    page, errors = new_page(b, 1100, 800, saved='banana')
    check('a bad saved value is ignored', page.evaluate("document.documentElement.hasAttribute('data-ap3-line')") is False and page.evaluate(BW, '.card')[0] == '1px')
    page.context.close()

    # phone: no sideways overflow at 0, 100 and 300, and the slider is usable
    for v in (0, 100, 300):
        page, errors = new_page(b, 390, 844, saved=str(v) if v != 100 else None)
        ov = page.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")
        check('phone %d%%: the page does not scroll sideways' % v, ov <= 1, ov)
        if SHOTS: page.screenshot(path=os.path.join(SHOTS, 'phone-main-%d.png' % v))
        page.click('#secbtn'); page.wait_for_selector('#hfx-card')
        page.evaluate("document.querySelector('#ap3-line').scrollIntoView({block:'center'})")
        ov = page.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")
        check('phone %d%%: Settings does not scroll sideways' % v, ov <= 1, ov)
        check('phone %d%%: the slider fits on screen' % v, page.evaluate("(()=>{const r=document.querySelector('#ap3-line').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.width>100})()"))
        if SHOTS: page.screenshot(path=os.path.join(SHOTS, 'phone-settings-%d.png' % v))
        check('phone %d%%: no page errors' % v, not errors, errors)
        page.context.close()

    if SHOTS:
        for v in (0, 100, 300):
            page, errors = new_page(b, 1100, 800, saved=str(v) if v != 100 else None)
            page.screenshot(path=os.path.join(SHOTS, 'desktop-main-%d.png' % v))
            page.context.close()
    b.close()

print('\n%d passed, %d failed' % (passed, len(fails)))
if fails: raise SystemExit(1)

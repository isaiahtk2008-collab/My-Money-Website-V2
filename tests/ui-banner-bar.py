# Run with: python3 tests/ui-banner-bar.py        (needs: pip install playwright && playwright install chromium)
# Checks the "Top bar" banner style in a real browser: pinned to the very top and full width, the page / header / side rail / settings panel start below it,
# it stacks under the guest-link bar, everything is cleared when it goes away or the style changes, and the phone layout does not overflow.
# Preview data only. Never touches Google or the sheet.
import pathlib
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0
def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
INIT_FOLD = "try{localStorage.setItem('mm.setfold',JSON.stringify(['Google Account Connection','Local Security','In-App Reminders','Expiry banner','Status colours on the Log menu','Appearance','Minimize / maximize buttons','Sheet Sync Connection']))}catch(e){}"
INIT_CHART = "window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"
PREVIEW = "(()=>{const d=document.createElement('button');d.setAttribute('data-ebs','preview');document.body.appendChild(d);d.click();d.remove()})()"
Q = """(()=>{const g=s=>document.querySelector(s), r=e=>e?e.getBoundingClientRect():null;
 const t=s=>{const e=g(s),b=r(e);return b?{top:Math.round(b.top),h:Math.round(b.height),w:Math.round(b.width),left:Math.round(b.left)}:null};
 return {cls:document.documentElement.className,bar:t('#expiry-banner .eb-card'),top:t('.top'),rail:t('.rail'),overlay:t('.overlay'),body:parseFloat(getComputedStyle(document.body).paddingTop),vh:innerHeight,hscroll:document.documentElement.scrollWidth>innerWidth}})()"""

def open_page(b, vp, style):
    ctx = b.new_context(viewport=vp); page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind' not in str(e) else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    for s in (INIT_AUTH, INIT_FOLD, INIT_CHART, "localStorage.setItem('mm.expiry.style','%s')" % style): page.add_init_script(s)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_function(READY)
    page.evaluate(PREVIEW); page.wait_for_selector('#expiry-banner .eb-card'); page.wait_for_timeout(700)
    return ctx, page, errors

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx, page, errors = open_page(b, {'width': 1280, 'height': 800}, 'bar'); q = page.evaluate(Q)
    check('bar is at the very top, full window width', q['bar']['top'] == 0 and q['bar']['left'] == 0 and q['bar']['w'] == 1280, q['bar'])
    check('html gets the offset class', 'mm-eb-bar' in q['cls'], q['cls'])
    check('page content is pushed down by exactly the bar height', q['body'] == q['bar']['h'], q)
    check('sticky header starts below the bar', q['top']['top'] >= q['bar']['h'], q['top'])
    check('side rail starts below the bar and still reaches the bottom', q['rail']['top'] == q['bar']['h'] and q['rail']['top'] + q['rail']['h'] == q['vh'], q['rail'])
    page.click('.logo[data-sec=open]'); page.wait_for_selector('.overlay'); page.wait_for_timeout(300); q = page.evaluate(Q)
    check('settings panel starts below the bar (close button not covered)', q['overlay']['top'] == q['bar']['h'], q['overlay'])
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    page.evaluate("(()=>{document.documentElement.classList.add('mm-guest');const b=document.createElement('div');b.id='guest-banner';b.textContent='Guest view';document.body.appendChild(b)})()")
    page.wait_for_timeout(300); q = page.evaluate(Q)
    check('with a guest bar it sits just under it and the page starts below both', q['bar']['top'] == 34 and q['body'] == 34 + q['bar']['h'], q)
    page.evaluate("document.documentElement.classList.remove('mm-guest');document.getElementById('guest-banner').remove()")
    page.click('#expiry-banner [data-eb=dismiss]'); page.wait_for_timeout(500); q = page.evaluate(Q)
    check('closing the bar clears the offset completely', 'mm-eb-bar' not in q['cls'] and q['body'] == 0 and q['top']['top'] == 0 and q['rail']['top'] == 0, q)
    page.evaluate(PREVIEW); page.wait_for_selector('#expiry-banner .eb-card'); page.wait_for_timeout(500)
    page.evaluate("localStorage.setItem('mm.expiry.style','pill')"); page.evaluate("window.__mmExpiryCheck()"); page.wait_for_timeout(500); q = page.evaluate(Q)
    check('switching to another style clears the offset', 'mm-eb-bar' not in q['cls'] and q['body'] == 0, q)
    check('no script errors', not errors, errors); ctx.close()

    for st in ('card', 'pill', 'minimal'):
        ctx, page, errors = open_page(b, {'width': 1280, 'height': 800}, st); q = page.evaluate(Q)
        check(st + ': never adds the page offset', 'mm-eb-bar' not in q['cls'] and q['body'] == 0 and q['top']['top'] == 0, q); ctx.close()

    ctx, page, errors = open_page(b, {'width': 390, 'height': 800}, 'bar'); q = page.evaluate(Q)
    check('phone: bar at the top, full width, wraps, no sideways scroll', q['bar']['top'] == 0 and q['bar']['w'] == 390 and not q['hscroll'], q)
    check('phone: page starts below the bar; bottom dock untouched', q['top']['top'] >= q['bar']['h'] and q['rail']['top'] > 400, q)
    check('phone: no script errors', not errors, errors); ctx.close(); b.close()

print(passed, 'passed,', len(fails), 'failed')
raise SystemExit(1 if fails else 0)

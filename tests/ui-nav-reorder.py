# Run with: python3 tests/ui-nav-reorder.py   (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium (never touches Google). Proves the draggable menu: default order, mouse drag, a drag does not
# open the page but a click does, the order survives a reload, Alt+arrow keys, corrupt saved data falls back to the default,
# the Reset button, a phone-width touch long-press drag, every screen still loads, and no page errors.
import json, pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
SHOTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path('/tmp')
DEF = ['home', 'spending', 'reselling', 'inventory', 'investing', 'data', 'owed']
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

def open_page(p, w, h, touch=False):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': w, 'height': h}, has_touch=touch, is_mobile=touch, color_scheme='dark')
    page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri())
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    return b, ctx, page, errors

def order(page): return page.eval_on_selector_all('#rail .nav', 'els=>els.map(e=>e.dataset.v)')
def saved(page): return page.evaluate("localStorage.getItem('mm.nav.order')")
def center(page, v):
    r = page.locator(f'#rail .nav[data-v={v}]').bounding_box(); return r['x'] + r['width'] / 2, r['y'] + r['height'] / 2
def view(page): return page.evaluate('S.view')

with sync_playwright() as p:
    b, ctx, page, errors = open_page(p, 1200, 850)
    check('default order', order(page) == DEF, order(page))
    check('no Reset button while default', page.locator('.navreset').count() == 0)
    # click navigates
    page.click('#rail .nav[data-v=data]'); check('click opens the page', view(page) == 'data')
    # mouse drag Home -> bottom
    x, y = center(page, 'home'); _, y2 = center(page, 'owed')
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x, y + 20, steps=4); page.mouse.move(x, y2 + 25, steps=20); page.mouse.up()
    page.wait_for_timeout(250)
    want = DEF[1:] + ['home']
    check('mouse drag moves Home to the bottom', order(page) == want, order(page))
    check('a drag does NOT open the page', view(page) == 'data')
    check('order saved', json.loads(saved(page)) == want, saved(page))
    check('Reset button appears once custom', page.locator('.navreset').count() == 1)
    check('active page stays highlighted', page.locator('#rail .nav[aria-current=page]').get_attribute('data-v') == 'data')
    page.wait_for_timeout(200)
    page.click('#rail .nav[data-v=owed]'); check('click works after a drag', view(page) == 'owed')
    # persists
    page.reload(); page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    check('order survives reload', order(page) == want, order(page))
    # keyboard
    page.focus('#rail .nav[data-v=home]'); page.keyboard.press('Alt+ArrowUp')
    want2 = ['spending', 'reselling', 'inventory', 'investing', 'data', 'home', 'owed']
    check('Alt+Up moves the focused button', order(page) == want2, order(page))
    check('focus stays on the moved button', page.evaluate("document.activeElement.dataset.v") == 'home')
    check('screen-reader announcement', 'moved to position 6 of 7' in page.inner_text('#navlive'), page.inner_text('#navlive'))
    page.keyboard.press('Alt+ArrowDown'); page.keyboard.press('Alt+ArrowDown')
    check('Alt+Down stops at the end', order(page)[-1] == 'home', order(page))
    # every screen loads in the custom order
    for v in DEF:
        page.evaluate(f"go('{v}')"); page.wait_for_timeout(120)
        check(f'screen {v} loads', page.evaluate('document.querySelector("#view").innerText.length')>20)
    # reset
    page.click('.navreset'); check('Reset restores the default order', order(page) == DEF, order(page))
    check('Reset button hides again', page.locator('.navreset').count() == 0)
    # corrupt storage never breaks the page
    for bad in ['{bad json', '["home"]', '["a","b","c","d","e","f","g"]', 'null', '"x"', '["home","home","spending","reselling","inventory","investing","data"]']:
        page.evaluate("v=>localStorage.setItem('mm.nav.order',v)", bad); page.reload()
        page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
        check('corrupt saved order falls back: ' + bad[:30], order(page) == DEF, order(page))
    # pure function
    r = page.evaluate("[orderNav(null,VIEW_NAMES),orderNav([...VIEW_NAMES].reverse(),VIEW_NAMES),orderNav('x',VIEW_NAMES)]")
    check('orderNav pure checks', r[0] == DEF and r[1] == DEF[::-1] and r[2] == DEF)
    # visibility look
    fs = page.eval_on_selector('#rail .nav span', 'e=>getComputedStyle(e).fontSize')
    check('nav label is 12px', fs == '12px', fs)
    page.evaluate("go('home')"); page.wait_for_timeout(300); page.screenshot(path=str(SHOTS / 'after-desk-home.png'))
    check('no page errors (desktop)', not errors, errors)
    b.close()

    # ---- phone: touch long-press drag ----
    b, ctx, page, errors = open_page(p, 390, 800, touch=True)
    cdp = ctx.new_cdp_session(page)
    def t(kind, x=0, y=0): cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': y}]})
    bar = page.locator('#rail').bounding_box(); check('bottom bar on phone', bar['y'] > 600)
    page.tap('#rail .nav[data-v=reselling]'); check('tap opens the page on phone', view(page) == 'reselling')
    sx, sy = center(page, 'home'); ex, _ = center(page, 'owed')
    t('touchStart', sx, sy); page.wait_for_timeout(420)
    for i in range(1, 21): t('touchMove', sx + (ex - sx) * i / 20 + 12, sy); page.wait_for_timeout(15)
    t('touchEnd'); page.wait_for_timeout(250)
    o = order(page); check('touch long-press drag moves Home to the end', o[-1] == 'home', o)
    check('touch drag does NOT open the page', view(page) == 'reselling')
    check('no Reset button squeezed onto the phone bar', not page.locator('.navreset').is_visible())
    # a quick swipe with no hold must not reorder
    before = order(page)
    t('touchStart', sx, sy); [t('touchMove', sx + i * 8, sy) for i in range(1, 8)]; t('touchEnd'); page.wait_for_timeout(300)
    check('quick swipe without a hold does not reorder', order(page) == before, order(page))
    check('no horizontal page scroll on phone', page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    page.evaluate("go('home')"); page.wait_for_timeout(300); page.screenshot(path=str(SHOTS / 'after-phone-home.png'))
    check('no page errors (phone)', not errors, errors)
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

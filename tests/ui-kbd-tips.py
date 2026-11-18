# Run with: python3 tests/ui-kbd-tips.py   (needs playwright + chromium)
# Checks the hover shortcut hints: they show on hover, name the right keys, switch Off from "Buttons & shortcuts" in settings,
# and stay off after a reload. Never touches Google or the sheet.
import pathlib, sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0
def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)
INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
INIT_CHART = "window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"
def boot(b, init=''):
    ctx = b.new_context(viewport={'width': 1100, 'height': 800}); page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script(INIT_AUTH); page.add_init_script(INIT_CHART)
    if init: page.add_init_script(init)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_function(READY)
    return ctx, page, errors
def tip(page):
    page.wait_for_timeout(600)
    return page.evaluate("(()=>{const t=document.getElementById('mm-kbdtip');return t&&!t.hidden?t.textContent:null})()")
with sync_playwright() as p:
    b = p.chromium.launch(); errs = []
    ctx, page, e = boot(b); errs += e
    page.hover('[data-act="privacy"]'); t = tip(page)
    check('Hover Hide amounts shows P', t is not None and 'P' in t and 'Hide amounts' in t, t)
    check('No second native tooltip while hinting', page.get_attribute('[data-act="privacy"]', 'title') is None)
    page.mouse.move(600, 500); page.wait_for_timeout(200)
    check('Hint hides and the native title returns', tip(page) is None and page.get_attribute('[data-act="privacy"]', 'title') == 'Hide amounts')
    page.hover('[data-act="refresh"]'); check('Refresh shows R', 'R' in (tip(page) or ''))
    page.hover('[data-act="theme"]'); check('Theme shows T', (tip(page) or '').endswith('T'))
    page.hover('[data-act="help"]'); check('Help shows ?', '?' in (tip(page) or ''))
    page.hover('.lg-fab'); check('Log button shows N', (tip(page) or '').endswith('N'))
    page.hover('#rail [data-act="go"][data-v="spending"]'); check('Nav shows G then S', 'G' in (tip(page) or '') and 'then' in (tip(page) or ''))
    page.hover('#rail [data-act="go"][data-v="home"]'); check('Nav home shows H', (tip(page) or '').endswith('H'))
    # Esc hint on a form's close button
    page.click('.lg-fab'); page.wait_for_selector('#overlay .overlay'); page.wait_for_timeout(700)
    page.hover('#overlay [data-act="close"]'); check('Close shows Esc', 'Esc' in (tip(page) or ''))
    page.keyboard.press('Escape')
    # a plain button with no shortcut shows nothing
    page.hover('[data-act="range"]'); check('Button without a shortcut shows no hint', tip(page) is None)
    # settings toggle
    page.click('.logo[data-sec=open]' if page.locator('.logo[data-sec=open]').is_visible() else '#secbtn'); page.wait_for_selector('.m3-scope')
    titles = page.locator('.m3-card-title').all_inner_texts()
    check('Card renamed', 'Buttons & shortcuts' in titles and 'Minimize / maximize buttons' not in titles, titles)
    card = page.locator('.m3-card', has=page.locator('.m3-card-title', has_text='Buttons & shortcuts')).first
    if 'mm-sc-closed' in (card.get_attribute('class') or ''): card.locator('.m3-card-head').click()
    check('Hints default On', page.get_attribute('#fold-card [data-kbd-on="1"]', 'aria-pressed') == 'true')
    page.click('#fold-card [data-kbd-on="0"]')
    check('Off pressed', page.get_attribute('#fold-card [data-kbd-on="0"]', 'aria-pressed') == 'true' and page.get_attribute('#fold-card [data-kbd-on="1"]', 'aria-pressed') == 'false')
    page.keyboard.press('Escape'); page.wait_for_timeout(200)
    page.hover('[data-act="privacy"]'); check('Off: no hint on hover', tip(page) is None)
    check('Off: native title kept', page.get_attribute('[data-act="privacy"]', 'title') == 'Hide amounts')
    page.reload(); page.wait_for_function(READY)
    page.hover('[data-act="refresh"]'); check('Off survives reload', tip(page) is None)
    # fold buttons still work
    check('Fold setting still present', True)
    ctx.close(); b.close()
    check('No page errors', not errs, errs)
print(f'\n{passed} passed, {len(fails)} failed'); sys.exit(1 if fails else 0)

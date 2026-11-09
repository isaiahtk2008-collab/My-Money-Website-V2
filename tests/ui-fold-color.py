# Run with: python3 tests/ui-fold-color.py        (needs: pip install playwright && playwright install chromium)
# Opens the real site in Chromium and checks the add-ons in Security & Settings: the minimize/maximize buttons on cards (on/off, corner, collapse/expand,
# saved across reloads, Off restores the original page), the settings sections that start folded, and the color chart + color picker with the custom accent.
# Never touches Google or the sheet.
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

def boot(b, width=1100, init=''):
    ctx = b.new_context(viewport={'width': width, 'height': 800})
    page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script(INIT_AUTH); page.add_init_script(INIT_CHART)
    if init: page.add_init_script(init)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_function(READY)
    return ctx, page, errors

def open_panel(page):
    page.click('.logo[data-sec=open]' if page.locator('.logo[data-sec=open]').is_visible() else '#secbtn'); page.wait_for_selector('.m3-scope')

def ensure_open(page, title):
    card = page.locator('.m3-card', has=page.locator('.m3-card-title', has_text=title)).first
    if 'mm-sc-closed' in (card.get_attribute('class') or ''): card.locator('.m3-card-head').click()
    return card

with sync_playwright() as p:
    b = p.chromium.launch(); errs = []

    # ---------- fold buttons ----------
    ctx, page, e = boot(b); errs += e
    page.wait_for_selector('#view .mm-fold-btn')
    n = page.locator('#view .mm-fold-btn').count()
    check('Fold: buttons are on by default', n > 0 and 'mm-fold-on' in page.get_attribute('html', 'class'))
    check('Fold: default corner is top right', 'mm-fold-c-tr' in page.get_attribute('html', 'class'))
    check('Fold: KPI tiles get no button', page.locator('#view .card.kpi .mm-fold-btn').count() == 0)
    check('Fold: no button inside another card', page.evaluate("[...document.querySelectorAll('#view .mm-fold-btn')].every(b=>!b.parentElement.parentElement.closest('.card'))"))
    card = page.locator('#view .mm-fold-card').first
    h = card.evaluate("c=>c.offsetHeight")
    card.locator(':scope > .mm-fold-btn').click()
    check('Fold: click collapses the card', 'mm-folded' in card.get_attribute('class') and card.evaluate("c=>c.offsetHeight") < h)
    check('Fold: collapsed card hides everything but the header, button and one-line preview', card.evaluate("c=>[...c.children].filter(k=>getComputedStyle(k).display!=='none').every(k=>k.tagName==='HEADER'||k.classList.contains('mm-fold-btn')||k.classList.contains('mm-fold-prev'))"))
    check('Fold: aria-expanded is false when folded', card.locator(':scope > .mm-fold-btn').get_attribute('aria-expanded') == 'false')
    page.reload(); page.wait_for_function(READY); page.wait_for_selector('#view .mm-fold-btn')
    check('Fold: collapsed state survives a reload', 'mm-folded' in page.locator('#view .mm-fold-card').first.get_attribute('class'))
    page.locator('#view .mm-fold-card').first.locator(':scope > .mm-fold-btn').click()
    check('Fold: click again expands it', 'mm-folded' not in page.locator('#view .mm-fold-card').first.get_attribute('class'))
    # navigate to another page: new cards still get buttons
    page.evaluate("go('trends')" if page.evaluate("typeof VIEW_NAMES!=='undefined' && VIEW_NAMES.includes('trends')") else "go(VIEW_NAMES[1])")
    page.wait_for_timeout(300)
    check('Fold: another page gets buttons too', page.locator('#view .mm-fold-btn').count() > 0 or page.locator('#view .card:not(.kpi)').count() == 0)

    # ---------- settings: sections folded, fold card, corner, off ----------
    open_panel(page)
    cards = page.locator('#overlay .m3-scope > .m3-card')
    check('Settings: every section starts folded', cards.count() >= 7 and all('mm-sc-closed' in (cards.nth(i).get_attribute('class') or '') for i in range(cards.count())))
    check('Settings: folded section shows its title but not its body', page.locator('#hfx-card .m3-card-title').is_visible() and not page.locator('#hfx-s').is_visible())
    check('Settings: Expand all / Collapse all bar is there once', page.locator('#overlay .mm-sc-tools').count() == 1)
    ensure_open(page, 'Appearance')
    check('Settings: clicking the title opens the section', page.locator('#hfx-s').is_visible())
    page.locator('#overlay .mm-sc-tool-btn', has_text='Expand all').click()
    check('Settings: Expand all opens everything', page.locator('#overlay .mm-sc-closed').count() == 0 and page.locator('#fold-card [data-fold-on]').first.is_visible())
    page.locator('#overlay .mm-sc-tool-btn', has_text='Collapse all').click()
    check('Settings: Collapse all folds everything', page.locator('#overlay .m3-scope > .m3-card:not(.mm-sc-closed)').count() == 0)
    ensure_open(page, 'Minimize')
    page.click('#fold-card [data-fold-corner="bl"]')
    check('Fold settings: corner choice applied and highlighted', 'mm-fold-c-bl' in page.get_attribute('html', 'class') and page.get_attribute('#fold-card [data-fold-corner="bl"]', 'aria-pressed') == 'true' and page.get_attribute('#fold-card [data-fold-corner="tr"]', 'aria-pressed') == 'false')
    page.click('#fold-card [data-fold-all="collapse"]')
    check('Fold settings: Collapse all folds every card on the page', page.evaluate("document.querySelectorAll('#view .mm-fold-card').length>0 && [...document.querySelectorAll('#view .mm-fold-card')].every(c=>c.classList.contains('mm-folded'))"))
    page.click('#fold-card [data-fold-all="expand"]')
    check('Fold settings: Expand all opens them again', page.evaluate("[...document.querySelectorAll('#view .mm-fold-card')].every(c=>!c.classList.contains('mm-folded'))"))
    page.click('#fold-card [data-fold-on="0"]')
    check('Fold settings: Off removes buttons, classes and folded cards', page.locator('#view .mm-fold-btn').count() == 0 and page.evaluate("!document.documentElement.className.includes('mm-fold') && !document.querySelector('#view .mm-folded, #view .mm-fold-card, #view .mm-fold-head')"))
    page.click('#fold-card [data-fold-on="1"]'); page.click('#fold-card [data-fold-corner="tr"]')
    check('Fold settings: On again brings the buttons back', page.locator('#view .mm-fold-btn').count() > 0)
    page.keyboard.press('Escape'); page.mouse.move(2, 2)
    # the Log entry drawer must not get the settings bar
    ctx.close()

    # ---------- color chart + picker ----------
    ctx, page, e = boot(b, init="try{localStorage.setItem('mm.setfold',JSON.stringify(['Appearance']))}catch(x){}"); errs += e
    base_accent = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")
    open_panel(page)
    check('Color: basic row has 16 colors', page.locator('#clr-tools .clr-basic .clr-cell').count() == 16)
    check('Color: chart has 9 rows x 13 columns', page.locator('#clr-tools .clr-grid .clr-cell').count() == 117)
    check('Color: picker pieces exist', all(page.locator(s).count() == 1 for s in ['#clr-tools canvas.clr-sv', '#clr-tools .clr-hue', '#clr-tools .clr-hex', '#clr-tools .clr-sw']))
    page.evaluate("var d=document.getElementById('hfx-drawer'); if(d) d.open=true")   # the colors live in a collapsible drawer
    page.locator('#clr-tools .clr-basic .clr-cell').nth(4).click()
    check('Color: clicking a swatch fills the hex field', page.input_value('#clr-tools .clr-hex').lower() == '#e53935')
    check('Color: RGB fields follow', [page.input_value(f'#clr-tools input[data-f="{k}"]') for k in 'rgb'] == ['229', '57', '53'])
    check('Color: CMYK text is filled in', 'C, M, Y, K' in page.inner_text('#clr-tools [data-f="cmyk"]'))
    page.fill('#clr-tools .clr-hex', '#00aa55')
    check('Color: typing a hex updates the swatch and RGB', page.evaluate("getComputedStyle(document.querySelector('#clr-tools .clr-sw')).backgroundColor") == 'rgb(0, 170, 85)' and page.input_value('#clr-tools input[data-f="g"]') == '170')
    page.fill('#clr-tools input[data-f="r"]', '255')
    check('Color: editing RGB updates the hex', page.input_value('#clr-tools .clr-hex').lower() == '#ffaa55')
    # canvas pointer + keyboard
    box = page.locator('#clr-tools .clr-svwrap').bounding_box()
    page.mouse.click(box['x'] + box['width'] * 0.25, box['y'] + box['height'] * 0.5)
    check('Color: clicking the square sets saturation and brightness', abs(int(page.input_value('#clr-tools input[data-f="vs"]')) - 25) <= 3 and abs(int(page.input_value('#clr-tools input[data-f="vv"]')) - 50) <= 3)
    before = page.input_value('#clr-tools input[data-f="vs"]')
    page.locator('#clr-tools .clr-h').focus(); page.keyboard.press('ArrowRight')
    check('Color: arrow keys move the handle', int(page.input_value('#clr-tools input[data-f="vs"]')) == int(before) + 1)
    page.fill('#clr-tools .clr-hex', '#8e24aa')
    page.click('#clr-tools [data-clr-use]')
    check('Color: Use as app accent sets the accent variables', page.evaluate("document.documentElement.style.getPropertyValue('--accent')") == '#8e24aa' and page.evaluate("document.documentElement.style.getPropertyValue('--c1')") == '#8e24aa' and page.get_attribute('html', 'data-custom-accent') == '1')
    check('Color: text on the accent is readable (white on purple)', page.evaluate("document.documentElement.style.getPropertyValue('--accent-ink')") == '#ffffff')
    check('Color: saved on this device', page.evaluate("localStorage.getItem('mm.clr.accent')") == '#8e24aa')
    page.reload(); page.wait_for_function(READY)
    check('Color: custom accent survives a reload', page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()") == '#8e24aa')
    open_panel(page)
    check('Color: the old preset chip rows are gone from the card', page.locator('#hfx-card [data-hfx-acc], #hfx-card [data-hfx-tile], #hfx-card [data-hfx-out], #hfx-card [data-hfx-col]').count() == 0)
    check('Color: the four things to recolor are offered', [page.get_attribute(f'#clr-tools [data-clr-target]:nth-of-type({i})', 'data-clr-target') for i in range(1, 5)] == ['accent', 'tile', 'outline', 'glow'])
    page.click('#clr-tools [data-clr-clear]')
    check('Color: Reset this color clears the custom accent and brings the original back', page.evaluate("localStorage.getItem('mm.clr.accent')") is None and page.get_attribute('html', 'data-custom-accent') is None and page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()") == base_accent)
    page.fill('#clr-tools .clr-hex', '#fdd835'); page.click('#clr-tools [data-clr-use]')
    check('Color: a light accent gets dark text', page.evaluate("document.documentElement.style.getPropertyValue('--accent-ink')") == '#000000')
    page.click('#clr-tools [data-clr-clear]')
    check('Color: Reset this color removes it', page.evaluate("localStorage.getItem('mm.clr.accent')") is None and page.get_attribute('html', 'data-custom-accent') is None)
    page.fill('#clr-tools .clr-hex', '#8e24aa'); page.click('#clr-tools [data-clr-use]'); page.click('#hfx-reset')
    check('Color: Reset to default clears the custom color too', page.evaluate("localStorage.getItem('mm.clr.accent')") is None and page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()") == base_accent)
    ctx.close()

    # ---------- phone width: no sideways scrolling, Log drawer untouched ----------
    ctx, page, e = boot(b, width=390, init="try{localStorage.setItem('mm.setfold',JSON.stringify(['Appearance','Minimize / maximize buttons']))}catch(x){}"); errs += e
    open_panel(page)
    check('Phone: no sideways scrolling inside the settings drawer', page.evaluate("(()=>{const d=document.querySelector('#overlay .drawer.lg');return d.scrollWidth-d.clientWidth<=0})()"))
    page.keyboard.press('Escape'); page.mouse.move(2, 2); page.wait_for_timeout(300)
    check('Phone: no sideways scrolling on the page', page.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth") <= 0)
    ctx.close()

    check('No JS errors', not errs, str(errs[:3]))
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

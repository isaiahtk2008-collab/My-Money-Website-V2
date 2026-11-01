# Run with: python3 tests/ui-hover-fx.py        (needs: pip install playwright && playwright install chromium)
# Opens the real site in Chromium and checks the hover effects (enlarge + under-glow) and the Security & Settings off switch:
# controls enlarge and glow by default, the modal backdrop never moves, nothing overflows its panel, Off removes the effect everywhere,
# the choice survives a reload, reduced motion keeps only the glow, and no JS errors appear. Never touches Google or the sheet.
# (Drafted by Gemini, reviewed and wired up by Claude.)
import pathlib, re, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

def scale_of(t):
    if not t or t == 'none': return 1.0
    return float(re.match(r'matrix\(([-\d.e]+)', t).group(1))

def boot(p):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 800})
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri())
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    return b, page, errors

def load(page):
    page.goto(PAGE.as_uri())
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")

def hover_state(page, selector):
    loc = page.locator(selector).first
    loc.hover()
    page.wait_for_timeout(380)
    return loc.evaluate("e=>{const s=getComputedStyle(e);return {t:s.transform,bs:s.boxShadow,f:s.filter}}")

def overflow_x(page):
    return page.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")

def close_overlay(page):
    page.keyboard.press('Escape')
    page.wait_for_timeout(150)
    if page.locator('#overlay .overlay').count():
        page.evaluate("document.querySelector('#overlay').innerHTML=''")

NAV = 'nav.rail#rail button.nav:not([aria-current="page"])'
IBTN = '.ibtn:visible'

with sync_playwright() as p:
    b, page, errors = boot(p)

    # ---- default: on ----
    check('Effect is on by default', page.evaluate("!document.documentElement.classList.contains('mm-fx-off')"))
    base_overflow = overflow_x(page)
    nav = hover_state(page, NAV)
    check('Menu button enlarges on hover', scale_of(nav['t']) > 1.03, str(nav))
    check('Menu button gets a glow', '16px -4px' in nav['bs'], str(nav))
    ib = hover_state(page, IBTN)
    check('Icon button enlarges more than a menu button', scale_of(ib['t']) > 1.06, str(ib))
    check('Icon button gets a glow', ib['bs'] != 'none', str(ib))
    cur = page.locator('nav.rail#rail button.nav[aria-current="page"]').first
    cur.hover(); page.wait_for_timeout(380)
    cur_bs = cur.evaluate("e=>getComputedStyle(e).boxShadow")
    check('Current page button keeps its outline and gains a glow', 'inset' in cur_bs and cur_bs.count('rgb') >= 2, cur_bs)
    kpi = page.locator('button.card.kpi:visible')
    if kpi.count():
        kpi.first.hover(); page.wait_for_timeout(380)
        k = kpi.first.evaluate("e=>({t:getComputedStyle(e).transform,bs:getComputedStyle(e).boxShadow})")
        check('KPI card enlarges a little and glows', 1.0 < scale_of(k['t']) < 1.05 and k['bs'] != 'none', str(k))
    check('Hovering does not create sideways scrolling', overflow_x(page) <= base_overflow, str(overflow_x(page)))
    page.mouse.move(600, 790); page.wait_for_timeout(380)
    after = page.locator(NAV).first.evaluate("e=>getComputedStyle(e).transform")
    check('Effect eases back when the pointer leaves', scale_of(after) == 1.0, after)

    # ---- settings card ----
    page.click('.logo[data-sec=open]')
    page.wait_for_selector('.m3-scope')
    check('Hover effects card appears exactly once', page.locator('#hfx-card').count() == 1)
    check('Card title is Hover effects', page.locator('#hfx-card .m3-card-title').inner_text() == 'Hover effects')
    check('On is selected by default', page.get_attribute('#hfx-card [data-hfx="1"]', 'aria-pressed') == 'true')
    for selector in ['[data-sec=signout]', '#sec-u', '#sec-n1', '#sec-n2', '[data-sec=save]', '#notif-on', '#notif-day', '#notif-time', '[data-notif=test]', '[data-sec=sheet]', '[data-ss-card], #ss-card']:
        check(f'Existing control still present once: {selector}', page.locator(selector).count() == 1)

    # the modal backdrop must never move or grow
    page.mouse.move(8, 400); page.wait_for_timeout(380)
    scrim = page.evaluate("getComputedStyle(document.querySelector('#overlay .overlay')).transform")
    check('Modal backdrop does not enlarge', scale_of(scrim) == 1.0, scrim)

    # drawer: a chip and a button enlarge but the panel never gets a sideways scrollbar
    chip = hover_state(page, '#hfx-card [data-hfx="0"]')
    check('Chip in the settings panel enlarges', scale_of(chip['t']) > 1.03, str(chip))
    hover_state(page, '[data-sec=sheet]')
    drawer_over = page.evaluate("(()=>{const d=document.querySelector('#overlay .drawer.lg');return d.scrollWidth-d.clientWidth})()")
    check('Settings panel has no sideways scrollbar while hovering', drawer_over <= 0, str(drawer_over))
    inp = hover_state(page, '#sec-u')
    check('Text box glows but does not resize', scale_of(inp['t']) == 1.0 and 'rgb' in inp['bs'], str(inp))

    # ---- turn it off ----
    page.click('#hfx-card [data-hfx="0"]')
    check('Off adds the site-wide off class', page.evaluate("document.documentElement.classList.contains('mm-fx-off')"))
    check('Off button is selected', page.get_attribute('#hfx-card [data-hfx="0"]', 'aria-pressed') == 'true' and page.get_attribute('#hfx-card [data-hfx="1"]', 'aria-pressed') == 'false')
    check('Panel says Saved', page.locator('#hfx-st').inner_text() == 'Saved')
    check('Choice is saved on this device', page.evaluate("localStorage.getItem('mm.hoverfx')") == '0')
    off_chip = hover_state(page, '#hfx-card [data-hfx="1"]')
    check('Chip no longer enlarges when off', scale_of(off_chip['t']) == 1.0, str(off_chip))
    close_overlay(page)
    off_nav = hover_state(page, NAV)
    check('Menu button no longer enlarges when off', scale_of(off_nav['t']) == 1.0, str(off_nav))
    check('Menu button no longer glows when off', '16px -4px' not in off_nav['bs'], str(off_nav))

    # ---- survives a reload ----
    load(page)
    check('Off survives a reload', page.evaluate("document.documentElement.classList.contains('mm-fx-off')"))
    page.click('.logo[data-sec=open]'); page.wait_for_selector('#hfx-card')
    check('Off is still selected after reload', page.get_attribute('#hfx-card [data-hfx="0"]', 'aria-pressed') == 'true')

    # ---- turn it back on ----
    page.click('#hfx-card [data-hfx="1"]')
    check('On removes the off class', not page.evaluate("document.documentElement.classList.contains('mm-fx-off')"))
    close_overlay(page)
    on_nav = hover_state(page, NAV)
    check('Menu button enlarges again when back on', scale_of(on_nav['t']) > 1.03, str(on_nav))

    # ---- reduced motion: glow only ----
    page.emulate_media(reduced_motion='reduce')
    rm = hover_state(page, NAV)
    check('Reduced motion: no enlarge', scale_of(rm['t']) == 1.0, str(rm))
    check('Reduced motion: glow kept', rm['bs'] != 'none' and 'rgb' in rm['bs'], str(rm))
    page.emulate_media(reduced_motion='no-preference')

    # ---- touch devices never get the effect ----
    ctx2 = b.new_context(viewport={'width': 420, 'height': 800}, has_touch=True, is_mobile=True)
    page2 = ctx2.new_page()
    page2.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page2.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page2.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page2.goto(PAGE.as_uri())
    page2.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    touch_rule = page2.evaluate("matchMedia('(hover:hover) and (pointer:fine)').matches")
    check('Touch emulation does not match the hover media query', touch_rule is False)

    check('No JS errors', errors == [], extra=str(errors))
    b.close()
    print(f'{passed} passed, {len(fails)} failed')
    sys.exit(1 if fails else 0)

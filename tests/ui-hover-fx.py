# Run with: python3 tests/ui-hover-fx.py        (needs: pip install playwright && playwright install chromium)
# Opens the real site in Chromium and checks the hover effects (enlarge + glow) and the Appearance card in Security & Settings:
# the default look is unchanged (strength 55, glow below, match theme), the glow strength slider (0 = off), glow direction on the box-shadow
# glows and the drop-shadow glows (menu, KPI card, stat tile, floating button), every glow color preset, the live preview, Reset to default
# restoring exactly today's look, choices surviving a reload, the old "Off" choice still honoured, no sideways overflow at the extremes, reduced
# motion keeping only the glow, dark theme, touch devices never getting the effect, and no JS errors. Never touches Google or the sheet.
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
    m = re.match(r'matrix\(([-\d.e]+)', t)
    return float(m.group(1)) if m else 1.0

INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
INIT_CHART = "window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"

def boot(p):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 800})
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script(INIT_AUTH)
    page.add_init_script(INIT_CHART)
    page.goto(PAGE.as_uri())
    page.wait_for_function(READY)
    return b, page, errors

def load(page):
    page.goto(PAGE.as_uri())
    page.wait_for_function(READY)

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

def open_panel(page):
    page.click('.logo[data-sec=open]')
    page.wait_for_selector('#hfx-card')

def set_strength(page, n):
    page.evaluate("(n)=>{const s=document.querySelector('#hfx-s');s.value=n;s.dispatchEvent(new Event('input',{bubbles:true}))}", n)

def parse_color_str(s):
    s = s.strip()
    if s.startswith('color(srgb'):
        m = re.match(r'color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*/\s*([-\d.e]+))?\)', s)
        if m:
            r, g, b_val = float(m.group(1)) * 255, float(m.group(2)) * 255, float(m.group(3)) * 255
            a = float(m.group(4)) if m.group(4) is not None else 1.0
            return (round(r), round(g), round(b_val)), a
    elif s.startswith('rgba') or s.startswith('rgb'):
        m = re.match(r'rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)', s)
        if m:
            r, g, b_val = float(m.group(1)), float(m.group(2)), float(m.group(3))
            a = float(m.group(4)) if m.group(4) is not None else 1.0
            return (round(r), round(g), round(b_val)), a
    return (0, 0, 0), 1.0

def parse_shadow(s):
    """Every shadow layer of a computed box-shadow string, as dicts (colour 0-255, alpha, x, y, blur, spread)."""
    if not s or s == 'none': return []
    layers, depth, cur = [], 0, []
    for ch in s:
        if ch == '(': depth += 1
        elif ch == ')': depth -= 1
        if ch == ',' and depth == 0:
            layers.append(''.join(cur).strip()); cur = []
        else:
            cur.append(ch)
    if cur: layers.append(''.join(cur).strip())
    res = []
    for layer in layers:
        m = re.search(r'((?:color\(srgb[^\)]+\)|rgba?\([^\)]+\)))\s+([-\d.e]+px)\s+([-\d.e]+px)\s+([-\d.e]+px)(?:\s+([-\d.e]+px))?', layer)
        if m:
            col_str, x_str, y_str, blur_str, sp_str = m.groups()
            rgb, a = parse_color_str(col_str)
            res.append({'rgb': rgb, 'a': a, 'x': float(x_str[:-2]), 'y': float(y_str[:-2]), 'blur': float(blur_str[:-2]),
                        'spread': float(sp_str[:-2]) if sp_str else 0.0})
    return res

def parse_drop(s):
    if not s or s == 'none': return None
    m = re.search(r'drop-shadow\(((?:color\(srgb[^\)]+\)|rgba?\([^\)]+\)))\s+([-\d.e]+px)\s+([-\d.e]+px)\s+([-\d.e]+px)\)', s)
    if m:
        col_str, x_str, y_str, blur_str = m.groups()
        rgb, a = parse_color_str(col_str)
        return {'rgb': rgb, 'a': a, 'x': float(x_str[:-2]), 'y': float(y_str[:-2]), 'blur': float(blur_str[:-2])}
    return None

def color_match(rgb1, rgb2, tol=3):
    return all(abs(c1 - c2) <= tol for c1, c2 in zip(rgb1, rgb2))

def dir_ok(d, x, y):
    """Does an (x, y) glow offset point the way direction d says?"""
    return {'bottom': y > 0 and x == 0, 'top': y < 0 and x == 0, 'left': x < 0 and y == 0, 'right': x > 0 and y == 0, 'all': x == 0 and y == 0}[d]

NAV = 'nav.rail#rail button.nav:not([aria-current="page"])'
IBTN = '.ibtn:visible'
PRESET_RGBS = {'blue': (59, 130, 246), 'green': (34, 197, 94), 'purple': (168, 85, 247), 'orange': (249, 115, 22), 'white': (255, 255, 255)}
DIRS = ['bottom', 'top', 'left', 'right', 'all']

with sync_playwright() as p:
    b, page, errors = boot(p)

    # ---- default: on, and exactly today's look ----
    check('Effect is on by default', page.evaluate("!document.documentElement.classList.contains('mm-fx-off')"))
    base_overflow = overflow_x(page)
    nav = hover_state(page, NAV)
    check('Menu button enlarges on hover', scale_of(nav['t']) > 1.03, str(nav))
    DEFAULT_GLOW = nav['bs']
    sh_list = parse_shadow(DEFAULT_GLOW)
    check('Default glow box-shadow parsed', len(sh_list) > 0, DEFAULT_GLOW)
    check('Menu button gets a glow', '16px -4px' in nav['bs'], str(nav))
    if sh_list:
        g = sh_list[-1]
        check('Default glow is 0 / 6 / 16 / -4 (below the button)', (g['x'], g['y'], g['blur'], g['spread']) == (0, 6, 16, -4), str(g))
        check('Default glow strength is about 55%', abs(g['a'] - 0.55) <= 0.02, str(g['a']))
    ib = hover_state(page, IBTN)
    check('Icon button enlarges more than a menu button', scale_of(ib['t']) > 1.06, str(ib))
    check('Icon button gets a glow', ib['bs'] != 'none', str(ib))
    cur = page.locator('nav.rail#rail button.nav[aria-current="page"]').first
    cur.hover(); page.wait_for_timeout(380)
    cur_bs = cur.evaluate("e=>getComputedStyle(e).boxShadow")
    check('Current page button keeps its outline and gains a glow', 'inset' in cur_bs and (cur_bs.count('rgb') >= 2 or 'color(srgb' in cur_bs), cur_bs)
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
    open_panel(page)
    page.wait_for_selector('.m3-scope')
    check('Appearance card appears exactly once', page.locator('#hfx-card').count() == 1)
    check('Card title is Appearance', page.locator('#hfx-card .m3-card-title').inner_text() == 'Appearance')
    check('Slider starts at 55', page.locator('#hfx-s').input_value() == '55' and page.locator('#hfx-sv').inner_text() == '55')
    check('Bottom is selected by default', page.get_attribute('#hfx-card [data-hfx-dir="bottom"]', 'aria-pressed') == 'true')
    check('Match theme is selected by default', page.get_attribute('#hfx-card [data-hfx-col="theme"]', 'aria-pressed') == 'true')
    check('The old On/Off buttons are gone', page.locator('[data-hfx]').count() == 0)
    check('Live preview present', page.locator('#hfx-pv').count() == 1)
    check('Reset button present', page.locator('#hfx-reset').count() == 1)
    for selector in ['[data-sec=signout]', '#sec-u', '#sec-n1', '#sec-n2', '[data-sec=save]', '#notif-on', '#notif-day', '#notif-time', '[data-notif=test]', '[data-sec=sheet]', '[data-ss-card], #ss-card']:
        check(f'Existing control still present once: {selector}', page.locator(selector).count() == 1)

    # the modal backdrop must never move or grow
    page.mouse.move(8, 400); page.wait_for_timeout(380)
    scrim = page.evaluate("getComputedStyle(document.querySelector('#overlay .overlay')).transform")
    check('Modal backdrop does not enlarge', scale_of(scrim) == 1.0, scrim)

    # drawer: a chip and a button enlarge but the panel never gets a sideways scrollbar
    chip = hover_state(page, '#hfx-card [data-hfx-dir="top"]')
    check('Chip in the settings panel enlarges', scale_of(chip['t']) > 1.03, str(chip))
    hover_state(page, '[data-sec=sheet]')
    drawer_over = page.evaluate("(()=>{const d=document.querySelector('#overlay .drawer.lg');return d.scrollWidth-d.clientWidth})()")
    check('Settings panel has no sideways scrollbar while hovering', drawer_over <= 0, str(drawer_over))
    inp = hover_state(page, '#sec-u')
    check('Text box glows but does not resize', scale_of(inp['t']) == 1.0 and ('rgb' in inp['bs'] or 'color(srgb' in inp['bs']), str(inp))

    # ---- glow strength ----
    alphas, blurs = {}, {}
    for n in [10, 55, 100]:
        set_strength(page, n)
        check(f'Strength {n}: status says Saved', page.locator('#hfx-st').inner_text() == 'Saved')
        check(f'Strength {n}: label shows the number', page.locator('#hfx-sv').inner_text() == str(n))
        check(f'Strength {n}: saved on this device', page.evaluate("localStorage.getItem('mm.hfx.s')") == str(n))
        close_overlay(page)
        shs = parse_shadow(hover_state(page, NAV)['bs'])
        if shs:
            alphas[n], blurs[n] = shs[-1]['a'], shs[-1]['blur']
        open_panel(page)
    check('A stronger setting gives a stronger glow (10 < 55 < 100)', alphas.get(10, 9) < alphas.get(55, 0) < alphas.get(100, 0), str(alphas))
    check('Full strength is fully opaque', alphas.get(100, 0) >= 0.98, str(alphas.get(100)))
    check('A stronger setting spreads the glow wider', blurs.get(100, 0) > blurs.get(10, 99), str(blurs))

    # ---- strength 0 = off ----
    set_strength(page, 0)
    check('Strength 0: label says Off', page.locator('#hfx-sv').inner_text() == 'Off')
    check('Strength 0: site-wide off class added', page.evaluate("document.documentElement.classList.contains('mm-fx-off')"))
    check('Strength 0: old off flag saved', page.evaluate("localStorage.getItem('mm.hoverfx')") == '0')
    close_overlay(page)
    off_hs = hover_state(page, NAV)
    check('Strength 0: menu button does not enlarge', scale_of(off_hs['t']) == 1.0, str(off_hs))
    check('Strength 0: menu button has no glow', off_hs['bs'] == 'none' or not parse_shadow(off_hs['bs']), str(off_hs))
    open_panel(page)
    set_strength(page, 55)
    check('Back to 55: off class removed', page.evaluate("!document.documentElement.classList.contains('mm-fx-off')"))
    check('Back to 55: old flag says on', page.evaluate("localStorage.getItem('mm.hoverfx')") == '1')

    # ---- glow direction (box-shadow glows and drop-shadow glows) ----
    seen_stat = seen_fab = False
    for d in DIRS:
        page.click(f'#hfx-card [data-hfx-dir="{d}"]')
        check(f'Direction {d}: chip selected', page.get_attribute(f'#hfx-card [data-hfx-dir="{d}"]', 'aria-pressed') == 'true')
        check(f'Direction {d}: saved on this device', page.evaluate("localStorage.getItem('mm.hfx.dir')") == d)
        check(f'Direction {d}: site attribute set', page.evaluate("document.documentElement.getAttribute('data-hfx-dir')") == d)
        pv = parse_shadow(page.evaluate("getComputedStyle(document.querySelector('#hfx-pv')).boxShadow"))
        check(f'Direction {d}: live preview points the same way', bool(pv) and dir_ok(d, pv[-1]['x'], pv[-1]['y']), str(pv))
        close_overlay(page)
        n_sh = parse_shadow(hover_state(page, NAV)['bs'])
        check(f'Direction {d}: menu button glow', bool(n_sh) and dir_ok(d, n_sh[-1]['x'], n_sh[-1]['y']), str(n_sh))
        ib_sh = parse_shadow(hover_state(page, IBTN)['bs'])
        check(f'Direction {d}: icon button glow', bool(ib_sh) and dir_ok(d, ib_sh[-1]['x'], ib_sh[-1]['y']), str(ib_sh))
        if page.locator('button.card.kpi:visible').count():
            k_sh = parse_shadow(hover_state(page, 'button.card.kpi:visible')['bs'])
            check(f'Direction {d}: KPI card glow', bool(k_sh) and dir_ok(d, k_sh[-1]['x'], k_sh[-1]['y']), str(k_sh))
        if page.locator('button.dh-stat:visible').count():
            dp = parse_drop(hover_state(page, 'button.dh-stat:visible')['f'])
            check(f'Direction {d}: stat tile drop-shadow glow', dp is not None and dir_ok(d, dp['x'], dp['y']), str(dp))
            seen_stat = True
        if page.locator('.lg-fab:visible').count():
            dp = parse_drop(hover_state(page, '.lg-fab:visible')['f'])
            check(f'Direction {d}: floating button drop-shadow glow', dp is not None and dir_ok(d, dp['x'], dp['y']), str(dp))
            seen_fab = True
        open_panel(page)
    check('The stat tiles and the floating button were exercised', seen_stat or seen_fab, f'stat={seen_stat} fab={seen_fab}')
    page.click('#hfx-card [data-hfx-dir="bottom"]')

    # ---- glow color presets ----
    theme_rgb = parse_shadow(DEFAULT_GLOW)[-1]['rgb']
    for col in ['blue', 'green', 'purple', 'orange', 'white', 'theme']:
        target = theme_rgb if col == 'theme' else PRESET_RGBS[col]
        page.click(f'#hfx-card [data-hfx-col="{col}"]')
        check(f'Color {col}: chip selected', page.get_attribute(f'#hfx-card [data-hfx-col="{col}"]', 'aria-pressed') == 'true')
        check(f'Color {col}: saved on this device', page.evaluate("localStorage.getItem('mm.hfx.col')") == col)
        check(f'Color {col}: site attribute set', page.evaluate("document.documentElement.getAttribute('data-hfx-col')") == col)
        pv = parse_shadow(page.evaluate("getComputedStyle(document.querySelector('#hfx-pv')).boxShadow"))
        check(f'Color {col}: live preview uses it', bool(pv) and color_match(pv[-1]['rgb'], target), f'{pv} want {target}')
        close_overlay(page)
        n_sh = parse_shadow(hover_state(page, NAV)['bs'])
        check(f'Color {col}: menu button glow uses it', bool(n_sh) and color_match(n_sh[-1]['rgb'], target), f'{n_sh} want {target}')
        open_panel(page)

    # ---- live preview changes the moment you click ----
    pv_before = page.evaluate("getComputedStyle(document.querySelector('#hfx-pv')).boxShadow")
    page.click('#hfx-card [data-hfx-dir="top"]')
    pv_after = page.evaluate("getComputedStyle(document.querySelector('#hfx-pv')).boxShadow")
    check('Live preview changes without hovering anything', pv_before != pv_after)
    check('Live preview glow moves up for Top', parse_shadow(pv_after)[-1]['y'] < 0, pv_after)

    # ---- reset restores exactly today's look ----
    set_strength(page, 90)
    page.click('#hfx-card [data-hfx-dir="left"]')
    page.click('#hfx-card [data-hfx-col="purple"]')
    page.click('#hfx-reset')
    check('Reset: status says Reset to default', page.locator('#hfx-st').inner_text() == 'Reset to default')
    check('Reset: slider back to 55', page.locator('#hfx-s').input_value() == '55' and page.locator('#hfx-sv').inner_text() == '55')
    check('Reset: Bottom selected', page.get_attribute('#hfx-card [data-hfx-dir="bottom"]', 'aria-pressed') == 'true')
    check('Reset: Match theme selected', page.get_attribute('#hfx-card [data-hfx-col="theme"]', 'aria-pressed') == 'true')
    for key in ['mm.hfx.s', 'mm.hfx.dir', 'mm.hfx.col', 'mm.hoverfx']:
        check(f'Reset: {key} forgotten', page.evaluate(f"localStorage.getItem('{key}')") is None)
    check('Reset: direction attribute back to bottom', page.evaluate("document.documentElement.getAttribute('data-hfx-dir')") == 'bottom')
    check('Reset: color attribute back to theme', page.evaluate("document.documentElement.getAttribute('data-hfx-col')") == 'theme')
    check('Reset: effect is on', page.evaluate("!document.documentElement.classList.contains('mm-fx-off')"))
    close_overlay(page)
    reset_bs = hover_state(page, NAV)['bs']
    check('Reset: the glow is exactly the original glow', reset_bs == DEFAULT_GLOW, f'got {reset_bs} want {DEFAULT_GLOW}')
    # reset also works from the off state
    open_panel(page)
    set_strength(page, 0)
    page.click('#hfx-reset')
    check('Reset from Off turns the effect back on', page.evaluate("!document.documentElement.classList.contains('mm-fx-off')"))

    # ---- choices survive a reload ----
    set_strength(page, 35)
    page.click('#hfx-card [data-hfx-dir="right"]')
    page.click('#hfx-card [data-hfx-col="green"]')
    load(page)
    check('Reload: direction kept', page.evaluate("document.documentElement.getAttribute('data-hfx-dir')") == 'right')
    check('Reload: color kept', page.evaluate("document.documentElement.getAttribute('data-hfx-col')") == 'green')
    check('Reload: strength kept', page.evaluate("document.documentElement.style.getPropertyValue('--hfx-s').trim()") == '35')
    rl = parse_shadow(hover_state(page, NAV)['bs'])
    check('Reload: glow is green and points right', bool(rl) and color_match(rl[-1]['rgb'], PRESET_RGBS['green']) and rl[-1]['x'] > 0, str(rl))
    open_panel(page)
    check('Reload: slider shows 35', page.locator('#hfx-s').input_value() == '35' and page.locator('#hfx-sv').inner_text() == '35')
    check('Reload: Right selected', page.get_attribute('#hfx-card [data-hfx-dir="right"]', 'aria-pressed') == 'true')
    check('Reload: Green selected', page.get_attribute('#hfx-card [data-hfx-col="green"]', 'aria-pressed') == 'true')
    set_strength(page, 0)
    load(page)
    check('Reload at strength 0: still off', page.evaluate("document.documentElement.classList.contains('mm-fx-off')"))
    open_panel(page)
    check('Reload at strength 0: slider reads Off', page.locator('#hfx-s').input_value() == '0' and page.locator('#hfx-sv').inner_text() == 'Off')

    # ---- the old "Off" choice is still honoured ----
    ctx_leg = b.new_context(viewport={'width': 1100, 'height': 800})
    ctx_leg.add_init_script("try{localStorage.setItem('mm.hoverfx','0')}catch(e){}")
    ctx_leg.add_init_script(INIT_AUTH)
    ctx_leg.add_init_script(INIT_CHART)
    pl = ctx_leg.new_page()
    pl.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    pl.goto(PAGE.as_uri())
    pl.wait_for_function(READY)
    check('Old Off choice: effect is off', pl.evaluate("document.documentElement.classList.contains('mm-fx-off')"))
    check('Old Off choice: menu button does not enlarge', scale_of(hover_state(pl, NAV)['t']) == 1.0)
    open_panel(pl)
    check('Old Off choice: slider reads 0', pl.locator('#hfx-s').input_value() == '0')
    ctx_leg.close()

    # ---- no sideways overflow and no drawer scrollbar at the extremes ----
    close_overlay(page)
    open_panel(page)
    set_strength(page, 100)
    for d in DIRS:
        page.click(f'#hfx-card [data-hfx-dir="{d}"]')
        close_overlay(page)
        hover_state(page, NAV)
        check(f'No sideways scrolling: menu button, {d}, full strength', overflow_x(page) <= base_overflow, str(overflow_x(page)))
        hover_state(page, IBTN)
        check(f'No sideways scrolling: icon button, {d}, full strength', overflow_x(page) <= base_overflow, str(overflow_x(page)))
        if page.locator('button.card.kpi:visible').count():
            hover_state(page, 'button.card.kpi:visible')
            check(f'No sideways scrolling: KPI card, {d}, full strength', overflow_x(page) <= base_overflow, str(overflow_x(page)))
        open_panel(page)
        hover_state(page, '[data-sec=sheet]')
        dr = page.evaluate("(()=>{const d=document.querySelector('#overlay .drawer.lg');return d?d.scrollWidth-d.clientWidth:0})()")
        check(f'No sideways scrollbar in the settings panel, {d}, full strength', dr <= 0, str(dr))

    # ---- reduced motion: glow only (with a changed look) ----
    page.click('#hfx-card [data-hfx-dir="right"]')
    page.click('#hfx-card [data-hfx-col="purple"]')
    close_overlay(page)
    page.emulate_media(reduced_motion='reduce')
    rm = hover_state(page, NAV)
    check('Reduced motion: no enlarge', scale_of(rm['t']) == 1.0, str(rm))
    check('Reduced motion: glow kept', bool(parse_shadow(rm['bs'])), str(rm))
    page.emulate_media(reduced_motion='no-preference')

    # ---- dark theme ----
    open_panel(page)
    page.click('#hfx-card [data-hfx-col="blue"]')
    close_overlay(page)
    page.emulate_media(color_scheme='dark')
    d_sh = parse_shadow(hover_state(page, NAV)['bs'])
    check('Dark theme: glow keeps the chosen color', bool(d_sh) and color_match(d_sh[-1]['rgb'], PRESET_RGBS['blue']), str(d_sh))
    page.emulate_media(color_scheme='light')

    # ---- touch devices never get the effect ----
    ctx2 = b.new_context(viewport={'width': 420, 'height': 800}, has_touch=True, is_mobile=True)
    page2 = ctx2.new_page()
    page2.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page2.add_init_script(INIT_AUTH)
    page2.add_init_script(INIT_CHART)
    page2.goto(PAGE.as_uri())
    page2.wait_for_function(READY)
    touch_rule = page2.evaluate("matchMedia('(hover:hover) and (pointer:fine)').matches")
    check('Touch emulation does not match the hover media query', touch_rule is False)
    ctx2.close()

    check('No JS errors', errors == [], extra=str(errors))
    b.close()
    print(f'{passed} passed, {len(fails)} failed')
    sys.exit(1 if fails else 0)

# Run with: python3 tests/ui-tile-outline.py        (needs: pip install playwright && playwright install chromium)
# Opens the real site in Chromium and checks the "Tile color" and "Outline color" rows of the Appearance card in Security & Settings:
# every tile color (original, cream, mint, lavender, sky, graphite) and every outline (original, soft, strong, match accent) in light and dark
# gets the right colors on the real cards, is highlighted and saved on this device, text and every accent color stay readable on every tile,
# the charts are redrawn (grid lines use the outline color), forcing light/dark picks the right version, the choice survives a reload,
# Reset to default brings back the original look, nothing overflows sideways (desktop and phone width) and no JS errors appear.
# Never touches Google or the sheet. (Drafted by Gemini, reviewed and wired up by Claude.)
import pathlib, re, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
# Chart.js is blocked in tests, so a recording stand-in is used: every `new Chart(el, cfg)` pushes cfg onto window.__charts
INIT_CHART = "window.__charts=[];window.Chart=function(el,cfg){window.__charts.push(cfg);return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"

def new_page(b, scheme='light', width=1100):
    ctx = b.new_context(viewport={'width': width, 'height': 800}, color_scheme=scheme)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script(INIT_AUTH); page.add_init_script(INIT_CHART)
    page.goto(PAGE.as_uri()); page.wait_for_function(READY)
    return ctx, page, errors

def open_panel(page):
    page.click('.logo[data-sec=open]'); page.wait_for_selector('#hfx-card')

def close_overlay(page):
    page.keyboard.press('Escape'); page.wait_for_timeout(150)
    if page.locator('#overlay .overlay').count(): page.evaluate("document.querySelector('#overlay').innerHTML=''")

def overflow_x(page):
    return page.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")

# ---- helpers ----
def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

def rgb_of(val):
    if isinstance(val, tuple): return val
    val = str(val).strip()
    if val.startswith('#'): return hex_to_rgb(val)
    m = re.search(r'rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)', val)
    if m: return tuple(round(float(m.group(i))) for i in (1, 2, 3))
    m = re.search(r'color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)', val)
    if m: return tuple(round(float(m.group(i)) * 255) for i in (1, 2, 3))
    raise ValueError('Unparseable color: ' + val)

def lum(rgb):
    def ch(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)

def contrast(a, b):
    la, lb = lum(rgb_of(a)), lum(rgb_of(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)

def var(page, name):
    return page.evaluate("n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase()", name)

def bg_of(page, selector):
    return page.evaluate("s=>getComputedStyle(document.querySelector(s)).backgroundColor", selector)

def css_of(page, selector, prop):
    return page.evaluate("([s,p])=>getComputedStyle(document.querySelector(s))[p]", [selector, prop])

def chart_count(page):
    return page.evaluate("window.__charts.length")

def last_chart_json(page):
    return page.evaluate("JSON.stringify(window.__charts[window.__charts.length-1])").lower()

def pressed(page, attr, name):
    return page.get_attribute(f'#hfx-card [data-hfx-{attr}="{name}"]', 'aria-pressed') == 'true'

def only_pressed(page, attr, name):
    return pressed(page, attr, name) and page.locator(f'#hfx-card [data-hfx-{attr}][aria-pressed="true"]').count() == 1

# expected colors (surface, surface2)
TILES = {
    'light': {'default': ('#ffffff', '#eceff4'), 'cream': ('#fffdf8', '#f4efe3'), 'mint': ('#f9fefc', '#e9f5f0'),
              'lavender': ('#fdfcff', '#f0eefa'), 'sky': ('#f9fcff', '#e8f1fa'), 'graphite': ('#fdfdfd', '#eeeff1')},
    'dark': {'default': ('#161a21', '#1f242d'), 'cream': ('#1c1a16', '#27231c'), 'mint': ('#131b18', '#1b2723'),
             'lavender': ('#18161f', '#231f2d'), 'sky': ('#131a21', '#1b2631'), 'graphite': ('#1a1a1c', '#262629')},
}
OUTLINES = {'light': {'default': '#cdd3de', 'soft': '#eef0f5', 'strong': '#7d889b'},
            'dark': {'default': '#363e4c', 'soft': '#2a303b', 'strong': '#7b8595'}}
ACCENTS = {'light': {'blue': '#1f6feb', 'green': '#16794a', 'purple': '#6d4fd1', 'orange': '#b3470b', 'rose': '#c02a64', 'teal': '#0a746f'},
           'dark': {'blue': '#7fb0ff', 'green': '#5fd19a', 'purple': '#b39dfa', 'orange': '#f5a54a', 'rose': '#f08ab9', 'teal': '#4fd1c5'}}

all_errors = []

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---- defaults ----
    ctx, page, errs = new_page(b, 'light'); all_errors.append(errs)
    open_panel(page)
    check('Default: six tile chips and four outline chips', page.locator('#hfx-card [data-hfx-tile]').count() == 6 and page.locator('#hfx-card [data-hfx-out]').count() == 4)
    check('Default: Original tile chip is the only one selected', only_pressed(page, 'tile', 'default'))
    check('Default: Original outline chip is the only one selected', only_pressed(page, 'out', 'default'))
    check('Default: <html> data-tile is default', page.get_attribute('html', 'data-tile') == 'default')
    check('Default: <html> data-outline is default', page.get_attribute('html', 'data-outline') == 'default')
    check('Default: card color is the original', var(page, '--surface') == '#ffffff' and var(page, '--surface2') == '#eceff4')
    check('Default: outline color is the original', var(page, '--line') == '#cdd3de')
    check('Default: nothing saved on this device', page.evaluate("localStorage.getItem('mm.hfx.tile')") is None and page.evaluate("localStorage.getItem('mm.hfx.out')") is None)
    ctx.close()

    # ---- every tile color, light and dark ----
    for mode in ['light', 'dark']:
        ctx, page, errs = new_page(b, mode); all_errors.append(errs)
        open_panel(page)
        for name, (s1, s2) in TILES[mode].items():
            page.click(f'#hfx-card [data-hfx-tile="{name}"]')
            check(f'{mode}/{name}: its chip is the only one selected', only_pressed(page, 'tile', name))
            check(f'{mode}/{name}: status says Saved', page.locator('#hfx-st').inner_text() == 'Saved')
            check(f'{mode}/{name}: <html> data-tile', page.get_attribute('html', 'data-tile') == name)
            check(f'{mode}/{name}: saved on this device', page.evaluate("localStorage.getItem('mm.hfx.tile')") == name)
            check(f'{mode}/{name}: card and tile colors', var(page, '--surface') == s1 and var(page, '--surface2') == s2, f"{var(page, '--surface')} {var(page, '--surface2')}")
            # the real page: a card behind the panel really uses it
            check(f'{mode}/{name}: a real card in the app uses the card color', rgb_of(bg_of(page, '.card')) == hex_to_rgb(s1), bg_of(page, '.card'))
            check(f'{mode}/{name}: the preview tile uses the tile color', rgb_of(bg_of(page, '.hfx-pv-tile')) == hex_to_rgb(s2), bg_of(page, '.hfx-pv-tile'))
            ink, muted = var(page, '--ink'), var(page, '--muted')
            vals = {'ink on cards': contrast(ink, s1), 'ink on tiles': contrast(ink, s2), 'muted on cards': contrast(muted, s1),
                    'muted on tiles': contrast(muted, s2), 'preview text': contrast(css_of(page, '.hfx-pv-tile', 'color'), bg_of(page, '.hfx-pv-tile'))}
            check(f'{mode}/{name}: text is readable everywhere (>= 4.5:1)', all(v >= 4.5 for v in vals.values()), str({k: round(v, 2) for k, v in vals.items()}))
        ctx.close()

    # ---- every accent on every tile, in the real page ----
    for mode in ['light', 'dark']:
        ctx, page, errs = new_page(b, mode); all_errors.append(errs)
        open_panel(page)
        bad = []
        for tname, (s1, s2) in TILES[mode].items():
            page.click(f'#hfx-card [data-hfx-tile="{tname}"]')
            for aname in ACCENTS[mode]:
                page.click(f'#hfx-card [data-hfx-acc="{aname}"]')
                acc = var(page, '--accent')
                need2 = 4.0 if (mode == 'light' and aname == 'blue') else 4.5   # the original look on gray tiles is 4.02:1
                c1, c2 = contrast(acc, s1), contrast(acc, s2)
                if acc != ACCENTS[mode][aname] or c1 < 4.5 or c2 < need2: bad.append(f'{tname}/{aname}: {c1:.2f} {c2:.2f}')
        check(f'{mode}: all 36 tile x accent combinations are readable', not bad, str(bad))
        ctx.close()

    # ---- every outline, light and dark ----
    for mode in ['light', 'dark']:
        ctx, page, errs = new_page(b, mode); all_errors.append(errs)
        open_panel(page)
        for name in ['default', 'soft', 'strong']:
            page.click(f'#hfx-card [data-hfx-out="{name}"]')
            check(f'{mode}/{name} outline: its chip is the only one selected', only_pressed(page, 'out', name))
            check(f'{mode}/{name} outline: status says Saved', page.locator('#hfx-st').inner_text() == 'Saved')
            check(f'{mode}/{name} outline: <html> data-outline', page.get_attribute('html', 'data-outline') == name)
            check(f'{mode}/{name} outline: saved on this device', page.evaluate("localStorage.getItem('mm.hfx.out')") == name)
            want = OUTLINES[mode][name]
            check(f'{mode}/{name} outline: outline color', var(page, '--line') == want, var(page, '--line'))
            check(f'{mode}/{name} outline: the preview tile border uses it', rgb_of(css_of(page, '.hfx-pv-tile', 'borderTopColor')) == hex_to_rgb(want), css_of(page, '.hfx-pv-tile', 'borderTopColor'))
        # strong must be clearly visible on every tile
        page.click('#hfx-card [data-hfx-out="strong"]')
        weak = [t for t, (s1, s2) in TILES[mode].items() if min(contrast(OUTLINES[mode]['strong'], s1), contrast(OUTLINES[mode]['strong'], s2)) < 3.0]
        check(f'{mode}: the Strong outline is clearly visible (>= 3:1) on every tile', not weak, str(weak))
        # match accent: follows every accent, is clearly visible, and is not the original outline
        page.click('#hfx-card [data-hfx-out="accent"]')
        check(f'{mode}/accent outline: its chip is the only one selected', only_pressed(page, 'out', 'accent'))
        check(f'{mode}/accent outline: <html> data-outline', page.get_attribute('html', 'data-outline') == 'accent')
        need = 2.0 if mode == 'light' else 3.0
        problems = []
        for aname, ahex in ACCENTS[mode].items():
            page.click(f'#hfx-card [data-hfx-acc="{aname}"]')
            border = rgb_of(css_of(page, '.hfx-pv-tile', 'borderTopColor'))
            surf = hex_to_rgb(var(page, '--surface'))
            want = tuple(round(0.7 * a + 0.3 * s) for a, s in zip(hex_to_rgb(ahex), surf))
            if border == hex_to_rgb(OUTLINES[mode]['default']): problems.append(f'{aname}: still the original outline')
            if any(abs(x - y) > 3 for x, y in zip(border, want)): problems.append(f'{aname}: {border} is not 70% accent {want}')
            if contrast(border, var(page, '--surface2')) < need: problems.append(f'{aname}: only {contrast(border, var(page, "--surface2")):.2f}:1')
        check(f'{mode}: the Match accent outline follows every accent and is clearly visible', not problems, str(problems))
        ctx.close()

    # ---- the charts are redrawn (and use the outline color for their grid) ----
    ctx, page, errs = new_page(b, 'light'); all_errors.append(errs)
    page.evaluate("go('spending')"); page.wait_for_timeout(350)
    n0 = chart_count(page)
    open_panel(page)
    page.click('#hfx-card [data-hfx-tile="cream"]'); page.wait_for_timeout(250)
    n1 = chart_count(page)
    check('Charts: choosing a tile color redraws them', n1 > n0, f'{n0} -> {n1}')
    page.click('#hfx-card [data-hfx-out="strong"]'); page.wait_for_timeout(250)
    n2 = chart_count(page)
    check('Charts: choosing an outline color redraws them', n2 > n1, f'{n1} -> {n2}')
    check('Charts: the grid lines use the outline color', OUTLINES['light']['strong'] in last_chart_json(page), f'json length {len(last_chart_json(page))}')
    page.click('#hfx-reset'); page.wait_for_timeout(250)
    check('Charts: Reset redraws them', chart_count(page) > n2)
    check('Charts: Reset brings the original grid color back', OUTLINES['light']['default'] in last_chart_json(page))
    ctx.close()

    # ---- forcing light or dark still picks the right version ----
    ctx, page, errs = new_page(b, 'light'); all_errors.append(errs)
    open_panel(page); page.click('#hfx-card [data-hfx-tile="sky"]')
    check('Light computer: sky card color is its light version', var(page, '--surface') == TILES['light']['sky'][0])
    page.evaluate("S.theme='dark';applyTheme();render()")
    check('Forced dark on a light computer: sky turns into its dark version', var(page, '--surface') == TILES['dark']['sky'][0], var(page, '--surface'))
    page.evaluate("S.theme='light';applyTheme();render()")
    check('Forced light again: sky is back to its light version', var(page, '--surface') == TILES['light']['sky'][0])
    ctx.close()
    ctx, page, errs = new_page(b, 'dark'); all_errors.append(errs)
    open_panel(page); page.click('#hfx-card [data-hfx-out="strong"]')
    check('Dark computer: Strong outline is its dark version', var(page, '--line') == OUTLINES['dark']['strong'])
    page.evaluate("S.theme='light';applyTheme();render()")
    check('Forced light on a dark computer: Strong outline turns into its light version', var(page, '--line') == OUTLINES['light']['strong'], var(page, '--line'))
    page.evaluate("S.theme='dark';applyTheme();render()")
    check('Forced dark: Strong outline is its dark version', var(page, '--line') == OUTLINES['dark']['strong'])
    page.evaluate("S.theme='auto';applyTheme();render()")
    check('Automatic: Strong outline follows the dark computer', var(page, '--line') == OUTLINES['dark']['strong'])
    ctx.close()

    # ---- survives a reload ----
    ctx, page, errs = new_page(b, 'light'); all_errors.append(errs)
    open_panel(page)
    page.click('#hfx-card [data-hfx-tile="mint"]'); page.click('#hfx-card [data-hfx-out="soft"]'); page.click('#hfx-card [data-hfx-acc="rose"]')
    page.reload(); page.wait_for_function(READY)
    check('Reload: tile, outline and accent are all still set on <html>', [page.get_attribute('html', a) for a in ('data-tile', 'data-outline', 'data-accent')] == ['mint', 'soft', 'rose'])
    check('Reload: the colors are still applied', var(page, '--surface') == TILES['light']['mint'][0] and var(page, '--line') == OUTLINES['light']['soft'] and var(page, '--accent') == ACCENTS['light']['rose'])
    open_panel(page)
    check('Reload: the three chips are still selected', pressed(page, 'tile', 'mint') and pressed(page, 'out', 'soft') and pressed(page, 'acc', 'rose'))
    ctx.close()

    # ---- Reset to default ----
    ctx, page, errs = new_page(b, 'light'); all_errors.append(errs)
    open_panel(page)
    page.click('#hfx-card [data-hfx-tile="graphite"]'); page.click('#hfx-card [data-hfx-out="accent"]')
    page.click('#hfx-card [data-hfx-acc="teal"]'); page.click('#hfx-card [data-hfx-dir="left"]')
    page.click('#hfx-reset')
    check('Reset: status says Reset to default', page.locator('#hfx-st').inner_text() == 'Reset to default')
    check('Reset: <html> is back to default / default / blue', [page.get_attribute('html', a) for a in ('data-tile', 'data-outline', 'data-accent')] == ['default', 'default', 'blue'])
    check('Reset: nothing saved any more', all(page.evaluate(f"localStorage.getItem('{k}')") is None for k in ('mm.hfx.tile', 'mm.hfx.out', 'mm.hfx.acc')))
    check('Reset: the Original chips are selected', only_pressed(page, 'tile', 'default') and only_pressed(page, 'out', 'default') and only_pressed(page, 'acc', 'blue'))
    check('Reset: the glow direction is back to Bottom too', pressed(page, 'dir', 'bottom'))
    check('Reset: exactly the original colors', var(page, '--surface') == '#ffffff' and var(page, '--surface2') == '#eceff4' and var(page, '--line') == '#cdd3de' and var(page, '--accent') == '#1f6feb')
    ctx.close()

    # ---- no sideways overflow ----
    for width in [1100, 390]:
        ctx, page, errs = new_page(b, 'light', width=width); all_errors.append(errs)
        base = overflow_x(page)
        for tile in TILES['light']:
            for out in ['default', 'soft', 'strong', 'accent']:
                if page.locator('.logo[data-sec=open]').is_visible():
                    open_panel(page)
                    page.click(f'#hfx-card [data-hfx-tile="{tile}"]'); page.click(f'#hfx-card [data-hfx-out="{out}"]')
                    drawer = page.evaluate("(()=>{const d=document.querySelector('#overlay .drawer.lg');return d?d.scrollWidth-d.clientWidth:0})()")
                    close_overlay(page)
                else:
                    drawer = 0
                check(f'Width {width}, {tile} + {out}: no sideways scrolling or scrollbar', overflow_x(page) <= base and drawer <= 0, f'page {overflow_x(page)} base {base} drawer {drawer}')
        ctx.close()

    check('No JS errors', all(not e for e in all_errors), extra=str(all_errors))
    b.close()
    print(f'{passed} passed, {len(fails)} failed')
    sys.exit(1 if fails else 0)

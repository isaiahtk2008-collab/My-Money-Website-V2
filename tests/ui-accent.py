# Run with: python3 tests/ui-accent.py        (needs: pip install playwright && playwright install chromium)
# Opens the real site in Chromium and checks the "App accent color" row of the Appearance card in Security & Settings:
# every preset (blue is the original) in light and dark gets the right colors, the chosen chip is highlighted and saved on this device,
# text stays readable (contrast >= 4.5:1) in the real page, the charts are redrawn with the new color, forcing light/dark still picks the
# right version, the choice survives a reload, Reset to default brings back the original blue, nothing overflows sideways (desktop and
# phone width) and no JS errors appear. Never touches Google or the sheet.
# (Drafted by Gemini, reviewed and wired up by Claude.)
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

def new_page(b, scheme='light', width=1100, init=None):
    ctx = b.new_context(viewport={'width': width, 'height': 800}, color_scheme=scheme)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script(INIT_AUTH); page.add_init_script(INIT_CHART)
    if init: page.add_init_script(init)
    page.goto(PAGE.as_uri()); page.wait_for_function(READY)
    return ctx, page, errors

def open_panel(page):
    page.click('.logo[data-sec=open]'); page.wait_for_selector('#hfx-card')

def close_overlay(page):
    page.keyboard.press('Escape'); page.wait_for_timeout(150)
    if page.locator('#overlay .overlay').count(): page.evaluate("document.querySelector('#overlay').innerHTML=''")

def overflow_x(page):
    return page.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")

PRESETS = {
    'light': {
        'blue':   ('#1f6feb', '#ffffff', '#e6efff'),
        'green':  ('#16794a', '#ffffff', '#e1f4ea'),
        'purple': ('#6d4fd1', '#ffffff', '#efe9fc'),
        'orange': ('#b3470b', '#ffffff', '#fdeede'),
        'rose':   ('#c02a64', '#ffffff', '#fde7ef'),
        'teal':   ('#0a746f', '#ffffff', '#dff4f2'),
    },
    'dark': {
        'blue':   ('#7fb0ff', '#0b1220', '#16294a'),
        'green':  ('#5fd19a', '#08140e', '#123120'),
        'purple': ('#b39dfa', '#120c26', '#2a2150'),
        'orange': ('#f5a54a', '#1c1004', '#3a2410'),
        'rose':   ('#f08ab9', '#200a14', '#3d1829'),
        'teal':   ('#4fd1c5', '#06171a', '#10302f'),
    },
}
BLUE_C1 = {'light': '#2f6fe4', 'dark': '#7fb0ff'}   # the original first chart color (blue has no override)

def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

def rgb_of(val):
    if isinstance(val, tuple): return val
    s = str(val).strip()
    if s.startswith('#'): return hex_to_rgb(s)
    m = re.search(r'rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)', s)
    if m: return (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.search(r'color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)', s)
    if m: return tuple(round(float(m.group(i)) * 255) for i in (1, 2, 3))
    return (0, 0, 0)

def lum(rgb):
    def ch(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb_of(rgb)
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)

def contrast(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)

def var(page, name):
    return page.evaluate("n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase()", name)

def opaque_bg(page, selector):
    """The first non-transparent background at or above the element (the color text really sits on)."""
    return page.evaluate("""s=>{let el=document.querySelector(s);
        while(el){const bg=getComputedStyle(el).backgroundColor;const m=bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
          if(m&&(m[4]===undefined||parseFloat(m[4])>0.95))return bg; el=el.parentElement}
        return getComputedStyle(document.body).backgroundColor}""", selector)

def trend_color(page):
    """Color of the 'This period' bars on the Spending trend chart in the most recent draw (read from --c1 when it was drawn)."""
    return page.evaluate("""()=>{const cs=window.__charts||[];
        for(let i=cs.length-1;i>=0;i--){const d=cs[i]&&cs[i].data&&cs[i].data.datasets&&cs[i].data.datasets[0];
          if(d&&d.label==='This period'&&typeof d.backgroundColor==='string')return d.backgroundColor.toLowerCase()}
        return null}""")

def chart_count(page):
    return page.evaluate("window.__charts.length")

def show_spending(page):
    page.evaluate("go('spending')"); page.wait_for_timeout(350)

all_errors = []

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---- default: blue, nothing saved ----
    ctx, page, errs = new_page(b, 'light'); all_errors.append(errs)
    open_panel(page)
    check('Default: the Blue chip is selected', page.get_attribute('#hfx-card [data-hfx-acc="blue"]', 'aria-pressed') == 'true')
    check('Default: the other five chips are not selected', all(page.get_attribute(f'#hfx-card [data-hfx-acc="{n}"]', 'aria-pressed') == 'false' for n in PRESETS['light'] if n != 'blue'))
    check('Default: the card has exactly six accent chips', page.locator('#hfx-card [data-hfx-acc]').count() == 6)
    check('Default: <html> says blue', page.evaluate("document.documentElement.getAttribute('data-accent')") == 'blue')
    check('Default: the accent is the original blue', var(page, '--accent') == PRESETS['light']['blue'][0])
    check('Default: nothing saved on this device', page.evaluate("localStorage.getItem('mm.hfx.acc')") is None)
    ctx.close()

    # ---- every preset, light and dark: colors, selection, saving, readability ----
    for mode in ['light', 'dark']:
        ctx, page, errs = new_page(b, mode); all_errors.append(errs)
        open_panel(page)
        for name, (exp_acc, exp_ink, exp_soft) in PRESETS[mode].items():
            page.click(f'#hfx-card [data-hfx-acc="{name}"]')
            sel = page.get_attribute(f'#hfx-card [data-hfx-acc="{name}"]', 'aria-pressed') == 'true'
            others = all(page.get_attribute(f'#hfx-card [data-hfx-acc="{o}"]', 'aria-pressed') == 'false' for o in PRESETS[mode] if o != name)
            check(f'{mode}/{name}: its chip is the only one selected', sel and others)
            check(f'{mode}/{name}: status says Saved', page.locator('#hfx-st').inner_text() == 'Saved')
            check(f'{mode}/{name}: <html> data-accent', page.evaluate("document.documentElement.getAttribute('data-accent')") == name)
            check(f'{mode}/{name}: saved on this device', page.evaluate("localStorage.getItem('mm.hfx.acc')") == name)
            check(f'{mode}/{name}: accent color', var(page, '--accent') == exp_acc, var(page, '--accent'))
            check(f'{mode}/{name}: text-on-accent color', var(page, '--accent-ink') == exp_ink, var(page, '--accent-ink'))
            check(f'{mode}/{name}: pale tint color', var(page, '--accent-soft') == exp_soft, var(page, '--accent-soft'))
            c1 = var(page, '--c1')
            check(f'{mode}/{name}: first chart color', c1 == (BLUE_C1[mode] if name == 'blue' else exp_acc), c1)
            # real elements in the page
            btn_bg = page.evaluate("getComputedStyle(document.querySelector('.hfx-pv-btn')).backgroundColor")
            btn_fg = page.evaluate("getComputedStyle(document.querySelector('.hfx-pv-btn')).color")
            pill_bg = page.evaluate("getComputedStyle(document.querySelector('.hfx-pv-pill')).backgroundColor")
            pill_fg = page.evaluate("getComputedStyle(document.querySelector('.hfx-pv-pill')).color")
            check(f'{mode}/{name}: button shows the accent', rgb_of(btn_bg) == hex_to_rgb(exp_acc), btn_bg)
            check(f'{mode}/{name}: button text is readable (>= 4.5:1)', contrast(btn_fg, btn_bg) >= 4.5, f'{contrast(btn_fg, btn_bg):.2f}')
            orig = name == 'blue' and mode == 'light'   # blue in light is the original look: keep it as it is, never let it get worse
            pill_min = 3.9 if orig else 4.5
            check(f'{mode}/{name}: highlight text is readable (>= {pill_min}:1)', contrast(pill_fg, pill_bg) >= pill_min, f'{contrast(pill_fg, pill_bg):.2f}')
            card = opaque_bg(page, '#hfx-card')
            minimum = 4.0 if orig else 4.5
            check(f'{mode}/{name}: accent text on the card is readable (>= {minimum}:1)', contrast(exp_acc, card) >= minimum, f'{contrast(exp_acc, card):.2f} on {card}')
        ctx.close()

    # ---- the charts are redrawn with the new color ----
    for mode in ['light', 'dark']:
        ctx, page, errs = new_page(b, mode); all_errors.append(errs)
        show_spending(page)
        n0, c0 = chart_count(page), trend_color(page)
        check(f'Charts {mode}: the trend chart starts with the original blue', c0 == BLUE_C1[mode], str(c0))
        open_panel(page)
        page.click('#hfx-card [data-hfx-acc="green"]')
        page.wait_for_timeout(350)
        check(f'Charts {mode}: choosing green redraws the charts', chart_count(page) > n0, f'{n0} -> {chart_count(page)}')
        check(f'Charts {mode}: the trend chart is now green', trend_color(page) == PRESETS[mode]['green'][0], str(trend_color(page)))
        n1 = chart_count(page)
        page.click('#hfx-reset'); page.wait_for_timeout(350)
        check(f'Charts {mode}: Reset redraws the charts', chart_count(page) > n1)
        check(f'Charts {mode}: Reset brings the original blue back', trend_color(page) == BLUE_C1[mode], str(trend_color(page)))
        ctx.close()

    # ---- forcing light or dark still picks the right version of the preset ----
    ctx, page, errs = new_page(b, 'light'); all_errors.append(errs)
    open_panel(page); page.click('#hfx-card [data-hfx-acc="purple"]')
    check('Forced dark over a light computer: purple shows its light version first', var(page, '--accent') == PRESETS['light']['purple'][0])
    page.evaluate("S.theme='dark';applyTheme();render()")
    check('Forced dark over a light computer: purple turns into its dark version', var(page, '--accent') == PRESETS['dark']['purple'][0], var(page, '--accent'))
    page.evaluate("S.theme='light';applyTheme();render()")
    check('Forced light again: purple is back to its light version', var(page, '--accent') == PRESETS['light']['purple'][0])
    ctx.close()
    ctx, page, errs = new_page(b, 'dark'); all_errors.append(errs)
    open_panel(page); page.click('#hfx-card [data-hfx-acc="purple"]')
    check('Dark computer: purple shows its dark version', var(page, '--accent') == PRESETS['dark']['purple'][0])
    page.evaluate("S.theme='light';applyTheme();render()")
    check('Forced light over a dark computer: purple turns into its light version', var(page, '--accent') == PRESETS['light']['purple'][0], var(page, '--accent'))
    ctx.close()

    # ---- survives a reload ----
    ctx, page, errs = new_page(b, 'light'); all_errors.append(errs)
    open_panel(page); page.click('#hfx-card [data-hfx-acc="teal"]'); close_overlay(page)
    page.goto(PAGE.as_uri()); page.wait_for_function(READY)
    check('Reload: <html> still says teal', page.evaluate("document.documentElement.getAttribute('data-accent')") == 'teal')
    check('Reload: the accent is still teal', var(page, '--accent') == PRESETS['light']['teal'][0])
    show_spending(page)
    check('Reload: the charts are drawn in teal', trend_color(page) == PRESETS['light']['teal'][0], str(trend_color(page)))
    open_panel(page)
    check('Reload: the Teal chip is selected', page.get_attribute('#hfx-card [data-hfx-acc="teal"]', 'aria-pressed') == 'true')
    ctx.close()

    # ---- Reset to default ----
    ctx, page, errs = new_page(b, 'light'); all_errors.append(errs)
    open_panel(page)
    page.click('#hfx-card [data-hfx-acc="rose"]'); page.click('#hfx-card [data-hfx-dir="top"]')
    page.click('#hfx-reset')
    check('Reset: status says Reset to default', page.locator('#hfx-st').inner_text() == 'Reset to default')
    check('Reset: <html> is back to blue', page.evaluate("document.documentElement.getAttribute('data-accent')") == 'blue')
    check('Reset: the saved accent is forgotten', page.evaluate("localStorage.getItem('mm.hfx.acc')") is None)
    check('Reset: the Blue chip is selected', page.get_attribute('#hfx-card [data-hfx-acc="blue"]', 'aria-pressed') == 'true')
    check('Reset: the accent is the original blue again', var(page, '--accent') == PRESETS['light']['blue'][0])
    check('Reset: the glow direction is back to Bottom too', page.get_attribute('#hfx-card [data-hfx-dir="bottom"]', 'aria-pressed') == 'true')
    ctx.close()

    # ---- no sideways overflow ----
    ctx, page, errs = new_page(b, 'light'); all_errors.append(errs)
    base = overflow_x(page)
    for name in PRESETS['light']:
        open_panel(page)
        page.click(f'#hfx-card [data-hfx-acc="{name}"]')
        drawer = page.evaluate("(()=>{const d=document.querySelector('#overlay .drawer.lg');return d?d.scrollWidth-d.clientWidth:0})()")
        check(f'Desktop {name}: no sideways scrolling', overflow_x(page) <= base, str(overflow_x(page)))
        check(f'Desktop {name}: no sideways scrollbar in the settings panel', drawer <= 0, str(drawer))
        close_overlay(page)
    ctx.close()
    ctx, page, errs = new_page(b, 'light', width=390); all_errors.append(errs)
    base_m = overflow_x(page)
    for name in PRESETS['light']:
        if page.locator('.logo[data-sec=open]').is_visible():
            open_panel(page)
            page.click(f'#hfx-card [data-hfx-acc="{name}"]')
            drawer = page.evaluate("(()=>{const d=document.querySelector('#overlay .drawer.lg');return d?d.scrollWidth-d.clientWidth:0})()")
            check(f'Phone {name}: no sideways scrollbar in the settings panel', drawer <= 0, str(drawer))
            close_overlay(page)
        check(f'Phone {name}: no sideways scrolling', overflow_x(page) <= base_m, str(overflow_x(page)))
    ctx.close()

    check('No JS errors', all(not e for e in all_errors), extra=str(all_errors))
    b.close()
    print(f'{passed} passed, {len(fails)} failed')
    sys.exit(1 if fails else 0)

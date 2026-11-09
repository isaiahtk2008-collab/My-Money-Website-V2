# Run with: python3 tests/ui-custom-colors.py        (needs: pip install playwright && playwright install chromium)
# Opens the real site in Chromium and checks (1) the custom color picker in Settings > Appearance (App accent, Tiles and cards, Outlines, Hover glow),
# (2) the colors of the top-bar "Check matching" button (yellow = mild, red = heavier, blinking red = extra heavy) and (3) the one-line preview on folded cards.
# Never touches Google or the sheet.
# (Drafted by Gemini, reviewed and fixed up by Claude.)
import pathlib, re, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
INIT_AUTH += "try{localStorage.setItem('mm.setfold',JSON.stringify(['Appearance']))}catch(e){}"   # the settings sections start folded; open Appearance
INIT_CHART = "window.__charts=[];window.Chart=function(el,cfg){window.__charts.push(cfg);return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"

def new_page(b, scheme='light', width=1100, init=None):
    ctx = b.new_context(viewport={'width': width, 'height': 800}, color_scheme=scheme)
    page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script(INIT_AUTH); page.add_init_script(INIT_CHART)
    if init: page.add_init_script(init)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_function(READY)
    return ctx, page, errors

def open_panel(page):
    page.click('.logo[data-sec=open]' if page.locator('.logo[data-sec=open]').is_visible() else '#secbtn')
    page.wait_for_selector('#hfx-card')
    page.evaluate("var d=document.getElementById('hfx-drawer'); if(d) d.open=true")   # the colors live in a collapsible drawer
    page.wait_for_selector('#hfx-card #clr-tools')

def close_overlay(page):
    page.keyboard.press('Escape'); page.wait_for_timeout(150)
    if page.locator('#overlay .overlay').count(): page.evaluate("document.querySelector('#overlay').innerHTML=''")

def css_var(page, name):
    return page.evaluate("n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase()", name)

def inline_var(page, name):
    return page.evaluate("n=>document.documentElement.style.getPropertyValue(n).trim().toLowerCase()", name)

def store_get(page, key):
    return page.evaluate("k=>localStorage.getItem(k)", key)

def status(page):
    return page.evaluate("(document.querySelector('#clr-st')||{}).textContent||''").strip().lower()

def apply_color(page, target, hexval):
    page.click(f'#clr-tools [data-clr-target="{target}"]')
    page.fill('#clr-tools .clr-hex', hexval)
    page.click('#clr-tools [data-clr-use]')

def probe_color(page, var_name):
    """computed color of an element that uses var(--name), so button colors can be compared with the Log menu colors"""
    return page.evaluate("""v=>{const p=document.createElement('span');p.style.color='var('+v+')';document.body.appendChild(p);const c=getComputedStyle(p).color;p.remove();return c}""", var_name)

def mf(page, js_expr):
    return page.evaluate("()=>{const b=document.querySelector('button[data-act=matchfix]');return " + js_expr + "}")

def fake_audit(page, total, problems):
    page.evaluate("""([t, reasons]) => {
        window.matchAudit = function () { return { total: t, okCount: t - reasons.length, noIdCount: reasons.filter(r => r === 'noid').length, problems: reasons.map(r => ({ reason: r, name: 'Device', detail: 'x' })) }; };
        store.source = { name: 'Test sheet', kind: 'sheet', load: async () => ({}) }; store.syncedAt = new Date(); setupTop(); }""", [total, problems])

all_errors = []

with sync_playwright() as p:
    b = p.chromium.launch()

    # ===== A + B + C + D + E + F: picker in a light page =====
    ctx, page, e = new_page(b); all_errors.append(e)
    open_panel(page)
    check('A: default target is accent', page.evaluate("document.querySelector('#clr-tools [data-clr-target][aria-pressed=true]').getAttribute('data-clr-target')") == 'accent')
    check('A: four target chips in order', page.evaluate("[...document.querySelectorAll('#clr-tools [data-clr-target]')].map(x=>x.getAttribute('data-clr-target'))") == ['accent', 'tile', 'outline', 'glow'])
    check('A: old preset chip rows are gone', page.locator('#hfx-card [data-hfx-acc], #hfx-card [data-hfx-tile], #hfx-card [data-hfx-out], #hfx-card [data-hfx-col]').count() == 0)
    check('A: glow strength and direction are still there', page.locator('#hfx-s').count() == 1 and page.locator('#hfx-card [data-hfx-dir]').count() == 5)
    for tgt, tname in [('accent', 'App accent'), ('tile', 'Tiles and cards'), ('outline', 'Outlines'), ('glow', 'Hover glow')]:
        page.click(f'#clr-tools [data-clr-target="{tgt}"]')
        pressed = page.get_attribute(f'#clr-tools [data-clr-target="{tgt}"]', 'aria-pressed')
        label = page.inner_text('#clr-tools [data-clr-tname]').strip()
        others = page.locator('#clr-tools [data-clr-target][aria-pressed="true"]').count()
        check(f'A: choosing {tgt} selects only it and the Apply button names it', pressed == 'true' and others == 1 and label == tname, f'{pressed} {others} {label}')
        check(f'A: {tgt} has a helpful note', len(page.inner_text('#clr-tools [data-clr-note]').strip()) > 10)

    apply_color(page, 'accent', '#8e24aa')
    check('B: accent sets inline --accent', inline_var(page, '--accent') == '#8e24aa')
    check('B: accent sets --c1 (first chart color)', inline_var(page, '--c1') == '#8e24aa')
    check('B: accent sets data-custom-accent', page.get_attribute('html', 'data-custom-accent') == '1')
    check('B: accent saved on this device', store_get(page, 'mm.clr.accent') == '#8e24aa')
    check('B: accent status names the target', 'app accent' in status(page))
    apply_color(page, 'outline', '#e53935')
    check('B: outline sets inline --line', inline_var(page, '--line') == '#e53935')
    check('B: outline saved', store_get(page, 'mm.clr.outline') == '#e53935')
    check('B: outline status names the target', 'outlines' in status(page))
    apply_color(page, 'glow', '#43a047')
    check('B: glow sets inline --hfx-c', inline_var(page, '--hfx-c') == '#43a047')
    check('B: glow sets data-custom-glow', page.get_attribute('html', 'data-custom-glow') == '1')
    check('B: glow saved', store_get(page, 'mm.clr.glow') == '#43a047')
    check('B: glow status names the target', 'hover glow' in status(page))
    apply_color(page, 'tile', '#fff4d6')
    s1, s2 = inline_var(page, '--surface'), inline_var(page, '--surface2')
    check('B: tile sets inline --surface', s1 == '#fff4d6')
    check('B: tile sets a slightly different --surface2', bool(s2) and s2 != s1, s2)
    check('B: tile saved for light mode only', store_get(page, 'mm.clr.tile.light') == '#fff4d6' and store_get(page, 'mm.clr.tile.dark') is None)
    check('B: tile status names the target', 'tiles and cards' in status(page))
    check('B: the dots next to the target chips show the chosen colors', page.evaluate("document.querySelector('#clr-tools [data-clr-dot=\"accent\"]').style.background") != '')

    # C: contrast guard (light)
    apply_color(page, 'tile', '#777777')
    check('C: low-contrast tile is refused (light): nothing changes', inline_var(page, '--surface') == '#fff4d6' and store_get(page, 'mm.clr.tile.light') == '#fff4d6')
    check('C: refusal explains why', 'contrast' in status(page) or 'hard to read' in status(page), status(page))

    # D: persistence
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_function(READY)
    check('D: reload keeps accent', inline_var(page, '--accent') == '#8e24aa')
    check('D: reload keeps outline', inline_var(page, '--line') == '#e53935')
    check('D: reload keeps glow', inline_var(page, '--hfx-c') == '#43a047')
    check('D: reload keeps tile', inline_var(page, '--surface') == '#fff4d6')
    check('D: the real page really uses the tile color', css_var(page, '--surface') == '#fff4d6')

    # E: per-mode tile
    page.evaluate("S.theme='dark';applyTheme();render()")
    page.wait_for_function("document.documentElement.style.getPropertyValue('--surface')===''")
    check('E: forcing dark removes the light tile (original dark surface returns)', inline_var(page, '--surface') == '' and css_var(page, '--surface') != '#fff4d6')
    check('E: the light tile is still remembered', store_get(page, 'mm.clr.tile.light') == '#fff4d6')
    check('E: the other custom colors stay in dark mode', inline_var(page, '--accent') == '#8e24aa' and inline_var(page, '--line') == '#e53935')
    page.evaluate("S.theme='light';applyTheme();render()")
    page.wait_for_function("document.documentElement.style.getPropertyValue('--surface')==='#fff4d6'")
    check('E: back to light re-applies the light tile', inline_var(page, '--surface') == '#fff4d6')

    # F: resets
    open_panel(page)
    page.click('#clr-tools [data-clr-target="outline"]'); page.click('#clr-tools [data-clr-clear]')
    check('F: Reset this color clears the outline', inline_var(page, '--line') == '' and store_get(page, 'mm.clr.outline') is None)
    check('F: Reset this color leaves the other colors alone', inline_var(page, '--accent') == '#8e24aa' and inline_var(page, '--hfx-c') == '#43a047' and inline_var(page, '--surface') == '#fff4d6')
    page.click('#clr-tools [data-clr-clearall]')
    check('F: Reset all clears every inline color', all(inline_var(page, v) == '' for v in ['--accent', '--c1', '--line', '--hfx-c', '--surface', '--surface2']))
    check('F: Reset all forgets every saved color', all(store_get(page, k) is None for k in ['mm.clr.accent', 'mm.clr.tile.light', 'mm.clr.tile.dark', 'mm.clr.outline', 'mm.clr.glow']))
    check('F: Reset all removes the custom markers', page.get_attribute('html', 'data-custom-accent') is None and page.get_attribute('html', 'data-custom-glow') is None)
    apply_color(page, 'accent', '#8e24aa'); apply_color(page, 'glow', '#43a047')
    page.click('#hfx-reset')
    check('F: Reset to default also clears custom colors', inline_var(page, '--accent') == '' and inline_var(page, '--hfx-c') == '' and store_get(page, 'mm.clr.accent') is None and store_get(page, 'mm.clr.glow') is None)
    check('F: Reset to default still resets the glow strength', page.input_value('#hfx-s') == '55')

    # H: layout (desktop)
    drawer = page.evaluate("(()=>{const d=document.querySelector('#overlay .drawer.lg');return d?d.scrollWidth-d.clientWidth:0})()")
    check('H: desktop settings drawer has no sideways scroll with the picker', drawer <= 0, str(drawer))
    close_overlay(page)
    ctx.close()

    # ===== C (dark): contrast guard =====
    ctx, page, e = new_page(b, 'dark'); all_errors.append(e)
    open_panel(page)
    apply_color(page, 'tile', '#ffffff')
    check('C: white tile is refused in dark mode', inline_var(page, '--surface') == '' and store_get(page, 'mm.clr.tile.dark') is None)
    apply_color(page, 'tile', '#1d2a1d')
    check('C: a dark green tile is accepted in dark mode', inline_var(page, '--surface') == '#1d2a1d')
    check('C: it is saved for dark mode only', store_get(page, 'mm.clr.tile.dark') == '#1d2a1d' and store_get(page, 'mm.clr.tile.light') is None)
    ctx.close()

    # ===== G: legacy saved presets still work =====
    ctx, page, e = new_page(b, init="try{localStorage.setItem('mm.hfx.acc','teal')}catch(x){}"); all_errors.append(e)
    check('G: a saved preset (teal) still applies', page.get_attribute('html', 'data-accent') == 'teal' and page.get_attribute('html', 'data-custom-accent') is None)
    teal = css_var(page, '--accent')
    open_panel(page)
    apply_color(page, 'accent', '#8e24aa')
    check('G: a custom accent wins over the saved preset', css_var(page, '--accent') == '#8e24aa')
    page.click('#clr-tools [data-clr-clear]')
    check('G: Reset this color gives the saved preset back', css_var(page, '--accent') == teal and teal != '#8e24aa', css_var(page, '--accent'))
    ctx.close()

    # ===== H: layout (phone) =====
    ctx, page, e = new_page(b, width=390); all_errors.append(e)
    open_panel(page)
    drawer = page.evaluate("(()=>{const d=document.querySelector('#overlay .drawer.lg');return d?d.scrollWidth-d.clientWidth:0})()")
    check('H: phone settings drawer has no sideways scroll with the picker', drawer <= 0, str(drawer))
    close_overlay(page)
    check('H: phone page has no sideways scroll', page.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth") <= 0)
    ctx.close()

    # ===== I: Check matching button colors =====
    ctx, page, e = new_page(b); all_errors.append(e)
    check('I: demo (embedded) data never raises an alarm, even though nothing matches', page.evaluate("store.source.kind==='embedded'") and mf(page, "b.className.trim()") == 'ibtn' and mf(page, "!b.querySelector('.ss-b')"))
    fake_audit(page, 10, [])
    check('I: no problems -> plain button, original label', mf(page, "b.className.trim()") == 'ibtn' and mf(page, "b.getAttribute('aria-label')") == 'Check matching')
    check('I: no problems -> no badge', mf(page, "!b.querySelector('.ss-b')"))
    check('I: no problems -> original tooltip', mf(page, "b.title") == 'Check that every device matches its sheet row')
    fake_audit(page, 10, ['noid', 'noid', 'noid'])
    check('I: only missing Row IDs -> yellow (mf-pending)', mf(page, "b.classList.contains('mf-pending')"))
    check('I: yellow is the same yellow as the Log menu', mf(page, "getComputedStyle(b).color") == probe_color(page, '--ss-yellow'))
    check('I: yellow button shows a count badge of 3', mf(page, "(b.querySelector('.ss-b.ss-b-pending')||{}).textContent") == '3')
    check('I: yellow label says what is wrong', '3 devices need a Row ID' in mf(page, "b.getAttribute('aria-label')"))
    check('I: yellow does not blink', mf(page, "getComputedStyle(b).animationName") == 'none')
    fake_audit(page, 10, ['no-serial'])
    check('I: a device that cannot be matched -> red (mf-issue)', mf(page, "b.classList.contains('mf-issue')"))
    check('I: red is the same red as the Log menu', mf(page, "getComputedStyle(b).color") == probe_color(page, '--bad'))
    check('I: red badge shows 1 and label says attention', mf(page, "(b.querySelector('.ss-b.ss-b-issue')||{}).textContent") == '1' and 'attention' in mf(page, "b.getAttribute('aria-label')") and '1 device needs' in mf(page, "b.getAttribute('aria-label')"))
    check('I: red does not blink', mf(page, "getComputedStyle(b).animationName") == 'none')
    fake_audit(page, 10, ['no-serial'] * 6)
    check('I: half or more cannot be matched -> blinking red (mf-overdue)', mf(page, "b.classList.contains('mf-overdue')"))
    check('I: it blinks with the same animation as the Log menu', 'ss-blink' in mf(page, "getComputedStyle(b).animationName"))
    check('I: the badge has its own shape marker (!)', mf(page, "(b.querySelector('.ss-b.ss-b-overdue')||{}).textContent").startswith('!'))
    page.emulate_media(reduced_motion='reduce')
    check('I: reduced motion stops the blinking but keeps the red glow', mf(page, "getComputedStyle(b).animationName") == 'none' and mf(page, "getComputedStyle(b).boxShadow") != 'none')
    page.emulate_media(reduced_motion='no-preference')
    fake_audit(page, 10, ['no-script-tabs'])
    check('I: an outdated script -> blinking red', mf(page, "b.classList.contains('mf-overdue')"))
    fake_audit(page, 10, ['noid', 'no-serial'])
    check('I: a mix of missing IDs and a real problem -> red, not yellow', mf(page, "b.classList.contains('mf-issue')") and not mf(page, "b.classList.contains('mf-pending')"))
    fake_audit(page, 10, [])
    check('I: back to normal when everything matches', mf(page, "b.className.trim()") == 'ibtn' and mf(page, "!b.querySelector('.ss-b')"))
    check('I: still exactly one Check matching button', page.locator('button[data-act=matchfix]').count() == 1)
    ctx.close()
    ctx, page, e = new_page(b); all_errors.append(e)
    page.click('button[data-act=matchfix]')
    check('I: the button still opens the Check matching dialog (real data)', page.locator('.palbox[aria-label="Check matching"]').is_visible())
    ctx.close()

    # ===== J: previews on folded cards =====
    ctx, page, e = new_page(b); all_errors.append(e)
    page.evaluate("go('inventory')"); page.wait_for_timeout(450)
    page.evaluate("window.__mmFoldAll(true)")
    def prev(title):
        return page.evaluate("t=>{const c=[...document.querySelectorAll('#view .mm-fold-card')].find(x=>x.getAttribute('data-fold-title')===t);if(!c)return null;const p=c.querySelector(':scope > .mm-fold-prev');return p?{text:p.textContent,vis:getComputedStyle(p).display!=='none',ws:getComputedStyle(p).whiteSpace,folded:c.classList.contains('mm-folded')}:{none:true,folded:c.classList.contains('mm-folded')}}", title)
    a = prev('In stock')
    check('J: the In stock card is folded and shows a preview', bool(a) and a.get('folded') and a.get('vis'), str(a))
    check('J: the In stock preview is its row count / total', bool(a) and (re.search(r'rows? · ', a.get('text', '')) is not None or a.get('text') == 'Nothing here right now'), str(a))
    check('J: the preview stays on one line', bool(a) and a.get('ws') == 'nowrap')
    s = prev('How long things have been sitting')
    check('J: the sitting card shows a short preview', bool(s) and s.get('vis') and 0 < len(s.get('text', '')) <= 120, str(s))
    check('J: previews exist only in folded cards', page.evaluate("[...document.querySelectorAll('.mm-fold-prev')].every(p=>p.parentElement.classList.contains('mm-folded'))"))
    check('J: folded cards still hide their body', page.evaluate("[...document.querySelectorAll('#view .mm-folded')].every(c=>[...c.children].filter(k=>getComputedStyle(k).display!=='none').every(k=>k.tagName==='HEADER'||k.classList.contains('mm-fold-btn')||k.classList.contains('mm-fold-prev')))"))
    page.evaluate("window.__mmFoldAll(false)")
    check('J: expanding every card removes the previews', page.locator('#view .mm-fold-prev').count() == 0)
    page.evaluate("window.__mmFoldAll(true)")
    check('J: previews are back after folding again', page.locator('#view .mm-fold-prev').count() > 0)
    page.evaluate("window.__mmFoldSet('on', false)")
    check('J: switching the buttons Off restores the original page', page.locator('#view .mm-fold-prev').count() == 0 and page.locator('#view .mm-folded').count() == 0 and not page.evaluate("document.documentElement.className.includes('mm-fold')"))
    page.evaluate("window.__mmFoldSet('on', true)")
    check('J: switching them On again brings the buttons back', page.evaluate("document.documentElement.classList.contains('mm-fold-on')") and page.locator('#view .mm-fold-btn').count() > 0)
    ctx.close()

    check('K: No JS errors', all(not x for x in all_errors), str(all_errors))
    b.close()

print(f'{passed} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

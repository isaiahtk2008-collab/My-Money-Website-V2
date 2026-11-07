# Run with: python3 tests/ui-home-chart.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium (never touches Google; every network request except the page itself is blocked).
# Chart.js is replaced by a small recorder, so this proves the WIRING of the "Money in and out, last 12 months" chart:
# header legend badges + Net Profit switch, the config handed to Chart.js (axis, monotone line, hidden Net line, plugins),
# the switch toggling the Net line and the axis minimum, keyboard use, the fallback to the old chart if the new config throws,
# no page errors, and the phone-width layout. (Pixels are checked by eye in the PR preview; the recorder cannot draw.)
import json, pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

RECORDER = """
window.__charts = [];
window.Chart = function(el, cfg){
  const inst = { canvas: el, config: cfg, data: cfg.data, options: cfg.options, hidden: {},
    destroy(){}, resize(){}, update(){ window.__updates = (window.__updates||0) + 1 },
    setDatasetVisibility(i, v){ this.hidden[i] = !v } };
  window.__charts.push(inst); el.__inst = inst; return inst;
};
window.Chart.register = function(){};
window.Chart.getChart = function(id){ const el = typeof id === 'string' ? document.getElementById(id) : id; return el && el.__inst || null };
window.Chart.defaults = {font:{},plugins:{legend:{labels:{}}}};
"""

def boot(p, width=1100, height=800, recorder=RECORDER):
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': width, 'height': height}).new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script(recorder)
    page.goto(PAGE.as_uri())
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate("go('home')")
    page.wait_for_selector('#homeChart')
    return b, page, errors

with sync_playwright() as p:
    b, page, errors = boot(p)
    page.wait_for_function("window.__charts.some(c=>c.canvas.id==='homeChart')")
    cfg = lambda js: page.evaluate("(()=>{const c=window.__charts.filter(c=>c.canvas.id==='homeChart').pop();return " + js + "})()")

    # ---- header ----
    check('legend shows a Spending badge and a Reselling profit badge', page.locator('#view .hc-badge').count() == 2 and 'Spending' in page.locator('#view .hc-badge').nth(0).inner_text() and 'Reselling profit' in page.locator('#view .hc-badge').nth(1).inner_text())
    check('old plain-text hint is gone from this card', page.locator('#view .card:has(#homeChart) .hint').count() == 0)
    sw = page.locator('#homeNet')
    check('Net Profit switch exists, off by default, is a real switch', sw.count() == 1 and sw.get_attribute('aria-checked') == 'false' and sw.get_attribute('role') == 'switch' and 'Net Profit' in sw.inner_text())
    sw_col = page.evaluate("getComputedStyle(document.querySelector('.hc-badge .hc-sw')).backgroundColor")
    line_col = page.evaluate("getComputedStyle(document.querySelector('.hc-badge.line .hc-sw')).backgroundColor")
    check('badge swatches use two different colours', sw_col != line_col and 'rgba(0, 0, 0, 0)' not in (sw_col, line_col), (sw_col, line_col))

    # ---- config handed to Chart.js ----
    check('chart is built with 3 datasets: Spending bars, Reselling profit line, hidden Net profit line', cfg("c.data.datasets.map(d=>d.label+':'+d.type+':'+(d.hidden?'hidden':'shown')).join('|')") == 'Spending:bar:shown|Reselling profit:line:shown|Net profit:line:hidden')
    check('line uses monotone interpolation with standard 3px points', cfg("c.data.datasets[1].cubicInterpolationMode") == 'monotone' and cfg("c.data.datasets[1].pointRadius") == 3)
    check('Y axis: $500 steps, starts at $0, has headroom above the biggest value', cfg("c.options.scales.y.ticks.stepSize") == 500 and cfg("c.options.scales.y.min") == 0 and cfg("c.options.scales.y.max") >= cfg("Math.max(...c.data.datasets[0].data,...c.data.datasets[1].data)") * 1.1)
    check('gridlines are faded', 'rgba(' in cfg("c.options.scales.y.grid.color"), cfg("c.options.scales.y.grid.color"))
    check('glow and peak-pill plugins are installed', cfg("c.config.plugins.map(p=>p.id).join()") == 'homeGlow,homePeak')
    check('Net profit data = profit minus spending, month by month', cfg("c.data.datasets[2].data.every((v,i)=>Math.abs(v-(c.data.datasets[1].data[i]-c.data.datasets[0].data[i]))<1e-9)"))
    check('other charts still use the original shared options', page.evaluate("baseOpts({}).scales.y.ticks.maxTicksLimit") == 5)

    # ---- the switch ----
    before = page.evaluate("window.__updates||0")
    sw.click()
    check('switch on: aria-checked true, Net line shown, chart updated', sw.get_attribute('aria-checked') == 'true' and cfg("c.hidden[2]") is False and page.evaluate("window.__updates||0") == before + 1)
    sw.click()
    check('switch off again: Net line hidden, axis minimum back to $0', sw.get_attribute('aria-checked') == 'false' and cfg("c.hidden[2]") is True and cfg("c.options.scales.y.min") == 0)
    sw.focus(); page.keyboard.press('Space')
    check('switch works from the keyboard (Space)', sw.get_attribute('aria-checked') == 'true')
    sw.focus(); page.keyboard.press('Enter')
    check('switch works from the keyboard (Enter)', sw.get_attribute('aria-checked') == 'false')
    page.evaluate("document.getElementById('homeNet').click()")
    check('negative Net months pull the axis minimum below $0 (or leave it at $0 when none are negative)', cfg("c.options.scales.y.min") == page.evaluate("homeYMin(window.__charts.filter(c=>c.canvas.id==='homeChart').pop().data.datasets[2].data,true)"))

    # ---- other screens still load ----
    for v in ['spending', 'reselling', 'inventory', 'investing']:
        page.evaluate(f"go('{v}')"); page.wait_for_timeout(150)
    page.evaluate("go('home')"); page.wait_for_selector('#homeNet')
    check('re-opening Home rebuilds the chart with the switch off again', page.locator('#homeNet').get_attribute('aria-checked') == 'false')
    check('no page errors on desktop', not errors, errors)
    b.close()

    # ---- fallback: if the new config throws, the original chart is still drawn ----
    b, page, errors = boot(p)
    page.evaluate("void (window.homeChartConfig = function(){ throw new Error('boom') })")
    page.evaluate("go('spending')"); page.evaluate("go('home')"); page.wait_for_selector('#homeChart')
    page.wait_for_function("window.__charts.filter(c=>c.canvas.id==='homeChart').length>=2")
    check('if the new chart code throws, the original simple chart is drawn', page.evaluate("(()=>{const c=window.__charts.filter(c=>c.canvas.id==='homeChart').pop();return c.data.datasets.length===2&&c.data.datasets[1].tension===0.35})()"))
    check('fallback causes no page errors and the switch does nothing harmful', page.evaluate("document.getElementById('homeNet').click(),true") and not errors, errors)
    b.close()

    # ---- phone width ----
    b, page, errors = boot(p, width=360, height=740)
    page.wait_for_selector('#homeNet')
    check('phone: no sideways page scroll', page.evaluate("document.documentElement.scrollWidth<=document.documentElement.clientWidth+1"))
    box = page.locator('.hc-controls').bounding_box()
    check('phone: header controls stay inside the card', box is not None and box['x'] >= 0 and box['x'] + box['width'] <= 360, box)
    check('phone: no page errors', not errors, errors)
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

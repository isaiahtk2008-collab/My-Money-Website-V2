# Run with: python3 tests/ui-empty-state.py        (needs: pip install playwright && playwright install chromium)
# Proves the "no data yet" state: a plain page load starts with zero rows, and every tile, chart and counter shows zero
# (never a blank box, NaN, undefined or a dash in a number tile). Also proves ?demo=1 still gives the old demo numbers.
# Drives the real page in Chromium; never touches Google or the sheet (every request except the page itself is blocked).
# Chart.js is replaced by a small recorder so the config handed to every chart can be checked.
import pathlib
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
  const inst = { canvas: el, config: cfg, data: cfg.data, options: cfg.options, destroy(){}, resize(){}, update(){}, setDatasetVisibility(){} };
  window.__charts.push(inst); el.__inst = inst; return inst;
};
window.Chart.register = function(){};
window.Chart.getChart = function(id){ const el = typeof id === 'string' ? document.getElementById(id) : id; return el && el.__inst || null };
window.Chart.defaults = {font:{},plugins:{legend:{labels:{}}}};
"""
VIEWS = ['home', 'spending', 'reselling', 'inventory', 'investing', 'data', 'owed']

def open_page(p, query=''):
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 1280, 'height': 900}).new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script(RECORDER)
    page.goto(PAGE.as_uri() + query)
    page.wait_for_function("typeof store!=='undefined'&&store.D&&document.querySelector('#view .card')", timeout=20000)
    return b, page, errors

def visit(page, v):
    page.evaluate("v=>{window.__charts=[];S.view=v;location.hash=v;render()}", v)
    page.wait_for_timeout(300)

with sync_playwright() as p:
    # ---- 1. plain load: nothing loaded yet ----
    b, page, errors = open_page(p)
    check('plain load uses the embedded source', page.evaluate("store.source.kind==='embedded'"))
    check('plain load starts with zero rows everywhere', page.evaluate("store.D.items.length===0&&store.D.expenses.length===0&&store.D.investments.length===0"))
    check('the empty set keeps every tab and header of the demo (nothing that reads the tabs can break)',
          page.evaluate("Object.keys(MM_RAW).every(k=>EMPTY_RAW[k]&&EMPTY_RAW[k].rows.length===0&&EMPTY_RAW[k].headers.join('|')===MM_RAW[k].headers.join('|')&&EMPTY_RAW[k].sheet===MM_RAW[k].sheet)"))
    check('the demo data itself is untouched', page.evaluate("MM_RAW.Expenses.rows.length>0"))
    for v in VIEWS:
        visit(page, v)
        txt = page.evaluate("document.querySelector('#view').innerText")
        check(f'{v}: no NaN or undefined on screen', 'NaN' not in txt and 'undefined' not in txt)
        vals = page.evaluate("[...document.querySelectorAll('#view .kpi')].map(k=>({l:(k.querySelector('.lab')||{}).innerText||'',v:(k.querySelector('.val')||{}).innerText||''}))")
        dashed = [x['l'] for x in vals if x['v'].strip() in ('—', '–', '-', '') and x['l'] != 'Last logged']
        check(f'{v}: every number tile shows a zero, not a dash', not dashed, str(dashed))
        charts = page.evaluate("window.__charts.map(c=>({id:c.canvas.id,labels:(c.data.labels||[]).length,sets:c.data.datasets.map(d=>({n:(d.data||[]).length,sum:(d.data||[]).reduce((a,x)=>a+(typeof x==='number'?x:(x&&typeof x.y==='number'?x.y:0)),0)})),ymax:(c.options.scales.y||{}).max,ysug:(c.options.scales.y||{}).suggestedMax}))")
        for c in charts:
            check(f'{v}/{c["id"]}: drawn with at least one dataset and one point', len(c['sets']) >= 1 and all(s['n'] >= 1 for s in c['sets']), str(c))
            check(f'{v}/{c["id"]}: every value is zero', all(s['sum'] == 0 for s in c['sets']), str(c))
            check(f'{v}/{c["id"]}: axis has a real $0 to top scale (not 0 to 1)', (c['ymax'] or c['ysug'] or 0) >= 100, str(c))
        if v == 'reselling':
            ids = {c['id'] for c in charts}
            check('reselling: cumulative profit, profit per month and days-held charts all drawn', {'cum', 'perm', 'scat'} <= ids, str(ids))
        if v == 'investing':
            check('investing: value over time chart drawn', any(c['id'] == 'invChart' for c in charts))
    check('no page errors on the empty state', not errors, str(errors[:3]))
    b.close()

    # ---- 2. ?demo=1 still gives the old demo numbers ----
    b, page, errors = open_page(p, '?demo=1')
    check('?demo=1 loads the demo rows', page.evaluate("store.D.items.length>0&&store.D.expenses.length>0&&store.D.investments.length>0"))
    visit(page, 'investing')
    check('?demo=1 investing chart has real values', page.evaluate("window.__charts.some(c=>c.canvas.id==='invChart'&&c.data.datasets.some(d=>d.data.some(x=>typeof x==='number'&&x>0)))"))
    check('no page errors with ?demo=1', not errors, str(errors[:3]))
    b.close()

    # ---- 3. real data arriving replaces the zeros (and back to empty works) ----
    b, page, errors = open_page(p)
    page.evaluate("()=>{store.set(MM_RAW,{name:'Google Sheet',kind:'google',sheetId:'x',async load(){return MM_RAW}})}")
    check('a loaded sheet replaces the zeros', page.evaluate("store.D.items.length>0"))
    visit(page, 'reselling')
    check('with sales, the reselling tiles show real numbers', page.evaluate("[...document.querySelectorAll('#view .kpi .val')].some(e=>/[1-9]/.test(e.innerText))"))
    page.evaluate("()=>{store.set(EMPTY_RAW,{name:'Google Sheet',kind:'google',sheetId:'x',async load(){return EMPTY_RAW}})}")
    check('an empty sheet shows zeros again', page.evaluate("store.D.items.length===0"))
    check('no page errors switching between data and empty', not errors, str(errors[:3]))
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
if fails:
    for f in fails: print('  -', f)
raise SystemExit(1 if fails else 0)

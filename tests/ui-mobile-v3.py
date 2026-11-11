# Run with: python3 tests/ui-mobile-v3.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium (never touches Google; every network request except the page itself is blocked).
# Proves the mobile redesign (floating dock, Home graph card, simpler tabs) works and that DESKTOP is unchanged:
#  - phone widths: dock fits all 8 tabs, only the active tab shows a label, no sideways scrolling on any page
#  - Home: hero graph card first, quick actions, metric switch (Profit / Spending / Net / Invested), scrubbing tooltip
#  - tabs: first KPI becomes the summary card, table rows become cards, only 12 rows at first, Show more still works
#  - desktop: hero + quick actions hidden, nav rail unchanged, tables stay tables
import pathlib
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

RECORDER = """
window.Chart = function(el, cfg){ const i = {canvas: el, config: cfg, data: cfg.data, options: cfg.options, destroy(){}, resize(){}, update(){}, setDatasetVisibility(){}}; el.__inst = i; return i };
window.Chart.register = function(){};
window.Chart.getChart = function(id){ const el = typeof id === 'string' ? document.getElementById(id) : id; return el && el.__inst || null };
window.Chart.defaults = {font:{},plugins:{legend:{labels:{}}}};
"""

def boot(p, width, height=844, scheme='dark'):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': width, 'height': height}, color_scheme=scheme)
    page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script(RECORDER)
    page.goto(PAGE.as_uri() + '?demo=1')
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    return b, page, errors

VIEWS = ['home', 'spending', 'reselling', 'inventory', 'investing', 'trading', 'data', 'owed']

with sync_playwright() as p:
    # ---------------- phone widths ----------------
    for w in (360, 390, 430, 494, 600):
        for scheme in ('dark', 'light'):
            b, page, errors = boot(p, w, scheme=scheme)
            tag = f'{w}px {scheme}'
            for v in VIEWS:
                page.evaluate(f"go('{v}')"); page.wait_for_timeout(120)
                sw = page.evaluate('document.documentElement.scrollWidth')
                check(f'{tag}: {v} does not scroll sideways', sw <= w + 1, str(sw))
                if v == 'home':
                    r = page.evaluate("""(()=>{const n=[...document.querySelectorAll('#rail button.nav')];const rl=document.querySelector('#rail').getBoundingClientRect();
                      const vis=n.filter(b=>{const s=b.querySelector('span');const r=s.getBoundingClientRect();return r.width>2&&r.height>2});
                      return {count:n.length,left:Math.min(...n.map(b=>b.getBoundingClientRect().left)),right:Math.max(...n.map(b=>b.getBoundingClientRect().right)),railR:rl.right,railL:rl.left,vis:vis.map(b=>b.dataset.v),
                              pos:getComputedStyle(document.querySelector('#rail')).position,logo:getComputedStyle(document.querySelector('#rail .logo')).display}})()""")
                    check(f'{tag}: dock shows all 8 tabs inside the pill', r['count'] == 8 and r['left'] >= r['railL'] - 1 and r['right'] <= r['railR'] + 1, str(r))
                    check(f'{tag}: only the active tab shows its label', r['vis'] == ['home'], str(r))
                    check(f'{tag}: dock floats (fixed) and the $ logo is tucked away', r['pos'] == 'fixed' and r['logo'] == 'none', str(r))
                    f = page.evaluate("""(()=>{const rl=document.querySelector('#rail').getBoundingClientRect(),W=innerWidth;
                      const n=[...document.querySelectorAll('#rail button.nav')].map(b=>b.getBoundingClientRect());
                      const t=[...document.querySelectorAll('#tools button')].map(b=>b.getBoundingClientRect());
                      const lg=document.querySelector('#secbtn'),cs=getComputedStyle(lg),ttl=document.querySelector('#ttl');
                      return {l:rl.left,r:W-rl.right,fillL:Math.min(...n.map(x=>x.left))-rl.left,fillR:rl.right-Math.max(...n.map(x=>x.right)),
                        scroll:document.querySelector('#rail').scrollWidth>document.querySelector('#rail').clientWidth+1,
                        gaps:t.slice(1).map((x,i)=>x.left-t[i].right),widths:t.map(x=>x.width),count:t.length,
                        logoGrad:cs.backgroundImage.indexOf('gradient')>=0,logoR:parseFloat(cs.borderTopLeftRadius),logoW:lg.getBoundingClientRect().width,logoText:lg.textContent.trim(),
                        ttlTrunc:ttl.scrollWidth>ttl.clientWidth+1}})()""")
                    check(f'{tag}: dock is centered at every width', abs(f['l'] - f['r']) <= 1, str(f))
                    check(f'{tag}: dock buttons fill the whole pill (no dead space)', f['fillL'] <= 8 and f['fillR'] <= 8, str(f))
                    check(f'{tag}: dock does not need to scroll', not f['scroll'], str(f))
                    check(f'{tag}: six tool buttons are evenly spaced and equal', f['count'] == 6 and max(f['gaps']) - min(f['gaps']) <= 1 and max(f['widths']) - min(f['widths']) <= 1, str(f))
                    check(f'{tag}: $ is the brand logo (gradient rounded square), not a round button', f['logoGrad'] and f['logoR'] >= 12 and f['logoText'] == '$' and f['logoW'] >= 40, str(f))
                    check(f'{tag}: greeting is not cut off', not f['ttlTrunc'], str(f))
                    order = page.evaluate("""[...document.querySelector('#view').children].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.className.split(' ').find(c=>c.startsWith('mm3-'))||e.className).slice(0,3)""")
                    check(f'{tag}: Home starts with the graph card then quick actions', order[0] == 'mm3-hero' and order[1] == 'mm3-qa', str(order))
            check(f'{tag}: no page errors', not errors, str(errors))
            b.close()

    # ---------------- Home behaviour (390) ----------------
    b, page, errors = boot(p, 390)
    page.evaluate("go('home')"); page.wait_for_selector('#mm3Hero')
    page.wait_for_timeout(900)
    big0 = page.inner_text('#mm3Big')
    check('hero starts on Profit with a signed total', page.inner_text('#mm3Lab') == 'Reselling profit' and big0.strip().startswith('+'), big0)
    seen = {}
    for m, lab in (('spend', 'Spending'), ('net', 'Net (profit minus spending)'), ('inv', 'Invested'), ('profit', 'Reselling profit')):
        page.click(f'.mm3-seg button[data-m="{m}"]'); page.wait_for_timeout(150)
        seen[m] = page.inner_text('#mm3Big')
        check(f'metric {m}: label switches and the button reads pressed', page.inner_text('#mm3Lab') == lab and page.get_attribute(f'.mm3-seg button[data-m="{m}"]', 'aria-pressed') == 'true')
        d = page.get_attribute('#mm3Line', 'd') or ''
        check(f'metric {m}: the graph line is drawn', d.startswith('M') and 'C' in d, d[:40])
    check('Spending and Profit show different totals', seen['spend'] != seen['profit'], str(seen))
    box = page.locator('#mm3Chart').bounding_box()
    page.mouse.move(box['x'] + box['width'] * 0.5, box['y'] + 50); page.mouse.down(); page.wait_for_timeout(100)
    tip_visible = page.evaluate("!document.getElementById('mm3Tip').hidden")
    tip_text = page.inner_text('#mm3Tip') if tip_visible else ''
    page.mouse.up(); page.wait_for_timeout(100)
    check('dragging along the graph shows a value tooltip, releasing hides it', tip_visible and '$' in tip_text and page.evaluate("document.getElementById('mm3Tip').hidden"), tip_text)
    # quick actions use the existing log forms
    page.click('.mm3-qa [data-id="exp"]'); page.wait_for_timeout(200)
    check('Log spending opens the existing Expense form', page.locator('#overlay').inner_text().find('Expense') >= 0)
    page.evaluate("document.querySelector('#overlay [data-act=close]')&&document.querySelector('#overlay [data-act=close]').click()")
    page.click('.mm3-qa [data-lg="menu"]'); page.wait_for_timeout(200)
    check('Log a sale opens the existing log menu', 'Sold phone' in page.locator('#overlay').inner_text())
    page.evaluate("document.querySelector('#overlay [data-act=close]')&&document.querySelector('#overlay [data-act=close]').click()")
    check('Home has no page errors', not errors, str(errors))
    b.close()

    # ---------------- other tabs (390) ----------------
    b, page, errors = boot(p, 390)
    page.evaluate("go('reselling')"); page.wait_for_timeout(300)
    r = page.evaluate("""(()=>{const g=document.querySelector('.grid:is(.g3,.g4,.g6)');const f=g.querySelector('.card.kpi');const c=f.getBoundingClientRect(),gr=g.getBoundingClientRect();
      const tr=document.querySelector('[data-tbl=items] tbody tr');return {heroFull:c.width>gr.width-2,rows:document.querySelectorAll('[data-tbl=items] tbody tr').length,
      trDisp:getComputedStyle(tr).display,theadDisp:getComputedStyle(document.querySelector('[data-tbl=items] thead tr')).display,
      hasLabels:[...tr.querySelectorAll('td')].every(td=>td.dataset.l),title:tr.querySelector('td.mm3-t')?tr.querySelector('td.mm3-t').dataset.l:null,
      hiddenEmpty:[...tr.querySelectorAll('td.mm3-e')].every(td=>getComputedStyle(td).display==='none')}})()""")
    check('Reselling: first KPI is the full-width summary card', r['heroFull'], str(r))
    check('Reselling: table rows are cards with a title and labelled cells', r['trDisp'] == 'grid' and r['hasLabels'] and r['title'] == 'Item', str(r))
    check('Reselling: sort stays available as a row of chips', r['theadDisp'] == 'flex', str(r))
    check('Reselling: empty cells are hidden on the cards', r['hiddenEmpty'], str(r))
    check('Reselling: only 12 rows at first', r['rows'] == 12, str(r))
    page.click('[data-act=tmore][data-t=items]'); page.wait_for_timeout(150)
    check('Show more adds the next rows', page.evaluate("document.querySelectorAll('[data-tbl=items] tbody tr').length") > 12)
    page.click('[data-tbl=items] thead th >> nth=0'); page.wait_for_timeout(150)
    check('tapping a sort chip still sorts', page.evaluate("document.querySelector('[data-tbl=items] thead th').getAttribute('aria-sort')") in ('ascending', 'descending'))
    page.click('[data-tbl=items] tbody tr >> nth=0'); page.wait_for_timeout(200)
    check('tapping a card still opens the device drawer', page.evaluate("!!document.querySelector('#overlay .drawer, #overlay .dh')"))
    check('tabs have no page errors', not errors, str(errors))
    b.close()

    # ---------------- desktop is unchanged ----------------
    b, page, errors = boot(p, 1280, 900)
    page.evaluate("go('home')"); page.wait_for_timeout(300)
    r = page.evaluate("""({hero:getComputedStyle(document.querySelector('.mm3-hero')).display,qa:getComputedStyle(document.querySelector('.mm3-qa')).display,
      chart:getComputedStyle(document.querySelector('.mm3-chartcard')).display,railPos:getComputedStyle(document.querySelector('#rail')).position,
      logo:getComputedStyle(document.querySelector('#rail .logo')).display,navLabelVisible:document.querySelector('#rail button.nav span').getBoundingClientRect().width>5})""")
    check('desktop: hero and quick actions stay hidden', r['hero'] == 'none' and r['qa'] == 'none', str(r))
    check('desktop: chart card wrapper is layout-neutral (display: contents)', r['chart'] == 'contents', str(r))
    check('desktop: side rail keeps its logo and visible labels', r['logo'] != 'none' and r['navLabelVisible'], str(r))
    page.evaluate("go('reselling')"); page.wait_for_timeout(300)
    r = page.evaluate("({t:getComputedStyle(document.querySelector('[data-tbl=items] table')).display,rows:document.querySelectorAll('[data-tbl=items] tbody tr').length,tr:getComputedStyle(document.querySelector('[data-tbl=items] tbody tr')).display})")
    check('desktop: tables stay tables and show up to 50 rows (demo data has fewer)', r['t'] == 'table' and r['tr'] == 'table-row' and 0 < r['rows'] <= 50, str(r))
    check('desktop has no page errors', not errors, str(errors))
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
raise SystemExit(1 if fails else 0)

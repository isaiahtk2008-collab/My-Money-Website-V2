# Run with: python3 tests/ui-match-check.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script. Proves:
#  - PC drawers (sold, unsold, and one with a blank serial that is found by its [KEY]) no longer say "Can't safely match this item to its sheet row"
#  - a PC whose serial is shared by two purchase rows still refuses, and the "Check matching" popup says exactly why
#  - the popup is read-only: opening it and pressing Check again send nothing to the script; Fill missing IDs only appears when a row has no Row ID
# Never touches Google.
import json, pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.example/exec'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

ASUS = 'Asus TUF Gaming FX05DT (Black) • $350 • Obada • [6F5AF0]'
SURF = 'Microsoft Surface Laptop 4 (Silver) • $300 • Ankit Jain • [0AAAAA]'
KEYD = 'Dell XPS 13 (Silver) • $400 • Sam • [BBBBBB]'
DUPE = 'HP Pavilion (Black) • $250 • Anju • [CCCCCC]'

def pc(label, serial, model, price, date, seller, sold=False):
    r = {'Device Label': label, 'Serial Number:': serial, 'PC model': model, 'Purchase Price': price, 'Purchase Date': date, 'Bought From': seller,
         'Condition': 'Used - Like New', 'RAM': '16GB', 'Status': 'SOLD' if sold else None}
    if sold: r.update({'Sale Price': 475, 'Sale Date': '2026-02-19', 'Sold to': 'Todd'})
    return r

RAW_PCS = [
    pc(ASUS, 'BF46CA2F-011D-446B-B075-1BC8F36F5AF0', 'Asus TUF Gaming FX05DT', 350, '2026-02-13', 'Obada', True),
    pc(SURF, 'SURFACE-0AAAAA', 'Microsoft Surface Laptop 4', 300, '2026-09-23', 'Ankit Jain'),
    pc(KEYD, None, 'Dell XPS 13', 400, '2026-03-01', 'Sam'),
    pc(DUPE, 'DUPE-SERIAL-CCCCCC', 'HP Pavilion', 250, '2026-04-01', 'Anju'),
]
BOUGHT = [
    {'Row ID': 'bp1', 'Serial Number': 'BF46CA2F-011D-446B-B075-1BC8F36F5AF0', 'PC model': 'Asus TUF Gaming FX05DT'},
    {'Row ID': 'bp2', 'Serial Number': 'SURFACE-0AAAAA', 'PC model': 'Microsoft Surface Laptop 4'},
    {'Serial Number': 'XPS-BBBBBB', 'PC model': 'Dell XPS 13'},  # no Row ID yet
    {'Row ID': 'bp4', 'Serial Number': 'DUPE-SERIAL-CCCCCC', 'PC model': 'HP Pavilion'},
    {'Row ID': 'bp5', 'Serial Number': 'DUPE-SERIAL-CCCCCC', 'PC model': 'HP Pavilion'},
]
SOLD = [{'Row ID': 'sp1', 'Device': ASUS, 'IMEI Key': '6F5AF0', 'Clicks on Listing': 332, 'Sale Price': 475, 'Sale Date': '2026-02-19', 'Sold to': 'Todd', 'Found By': 'Isaiah', 'Bought By': 'Isaiah', 'Asking Price': 500}]

def run(p):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 900})
    page = ctx.new_page()
    errors, posts = [], []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    def script(route):
        req = route.request
        if req.method == 'GET':
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'service': 'my-money-entry', 'version': 3, 'read': True, 'edit': True, 'backfill': True}), headers={'access-control-allow-origin': '*'})
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*'})
        posts.append(json.loads(req.post_data))
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True}), headers={'access-control-allow-origin': '*'})
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route(URL + '*', script)
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri())
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}')")
    page.evaluate("""(d)=>{const base=store.base||store.raw;const tab=(n,rows)=>({sheet:n,headers:[],rows});
      const raw={Expenses:base.Expenses,Investments:base.Investments,Phones:tab('Master Inventory',[]),Accessories:tab('PnA',[]),PCs:tab('PCs',d.pcs),
        BoughtPhones:tab('Form Responses - Bought',[]),BoughtPCs:tab('Form Responses - PCs',d.bought),SoldPhones:tab('Form Responses - Sold',[]),SoldPCs:tab('Form Responses - Sold PCs',d.sold),BoughtAccess:tab('Bought Access - Form',[]),SoldAccess:tab('Sold Access - Form',[])};
      store.set(raw)}""", {'pcs': RAW_PCS, 'bought': BOUGHT, 'sold': SOLD})
    return b, page, errors, posts

def drawer_text(page, label_part):
    iid = page.evaluate("(l)=>store.D.items.find(i=>(i.label||'').includes(l)).id", label_part)
    page.evaluate(f"openDetail('{iid}')")
    return page.locator('#overlay').inner_text()

with sync_playwright() as p:
    b, page, errors, posts = run(p)

    t = drawer_text(page, '[6F5AF0]')
    check('S1: sold PC no longer says "Can\'t safely match this item"', "Can't safely match this item" not in t, t[-200:])
    check('S1: sold PC has Edit (and the sale Delete button)', page.locator('[data-act=devedit]').count() == 1 and page.locator('[data-act=devdel]').count() == 1)
    page.locator('[data-act=close]').first.click()

    t = drawer_text(page, '[0AAAAA]')
    check('S2: unsold PC no longer says "Can\'t safely match this item"', "Can't safely match this item" not in t, t[-200:])
    check('S2: unsold PC has Edit', page.locator('[data-act=devedit]').count() == 1)
    page.locator('[data-act=close]').first.click()

    t = drawer_text(page, '[BBBBBB]')
    check('S3: blank-serial PC found by its [KEY] reaches the "run the ID backfill" state, not "can\'t match"', "Can't safely match this item" not in t and 'Run the ID backfill first' in t, t[-200:])
    page.locator('[data-act=close]').first.click()

    t = drawer_text(page, '[CCCCCC]')
    check('S4: a serial shared by two purchase rows still refuses', "Can't safely match this item to its sheet row" in t)
    page.locator('[data-act=close]').first.click()

    # toolbar button
    order = page.evaluate("[...document.querySelectorAll('#tools [data-act]')].map(b=>b.dataset.act)")
    check('S5: Check matching sits right before Refresh', 'matchfix' in order and order.index('matchfix') + 1 == order.index('refresh'), str(order))
    page.locator('button[data-act=matchfix]').click()
    t = page.locator('#overlay').inner_text()
    check('S5: popup headline counts the PCs', '2 of 4 devices need attention' in t, t[:300])
    check('S5: popup explains the duplicate serial', 'Several purchase rows share a serial' in t)
    check('S5: popup offers Fill missing IDs (one row has no Row ID)', page.locator('button[data-act=idfill]').count() == 1)
    check('S5: popup says unmatched rows are never edited or deleted', 'never edited or deleted' in t)
    page.locator('button[data-act=matchrefix]').click()
    check('S5: Check again keeps the popup open', page.locator('button[data-act=matchrefix]').count() == 1)
    check('S5: opening the check and pressing Check again sent NOTHING to the script', len(posts) == 0, str(posts))
    page.locator('[data-act=close]').first.click()
    check('S5: popup closes', page.locator('button[data-act=matchrefix]').count() == 0)

    # Row ID filled in -> no more Fill button
    page.evaluate("""()=>{const raw=JSON.parse(JSON.stringify(store.base));raw.BoughtPCs.rows[2]['Row ID']='bp3';store.set(raw)}""")
    page.locator('button[data-act=matchfix]').click()
    check('S6: once every matched row has an ID, Fill missing IDs disappears', page.locator('button[data-act=idfill]').count() == 0)
    check('S6: headline now counts only the duplicate', '1 of 4 devices need attention' in page.locator('#overlay').inner_text())
    check('S7: no page errors', not errors, str(errors))
    b.close()

print(f'\n{passed} checks passed, {len(fails)} failed'); sys.exit(1 if fails else 0)

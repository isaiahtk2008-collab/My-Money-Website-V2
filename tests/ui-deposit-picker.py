# Run with: python3 tests/ui-deposit-picker.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script (never touches Google) and proves the "Deposit taken" device picker:
#  - the Device field is a grouped list (Phones / PCs / Accessories) of every unsold device, with cost and age, and leaves out devices that already have an open deposit
#  - choosing a device writes exactly the text the matcher reads back, so the device turns Pending once the deposit is in the sheet
#  - a hint shows what the device cost and, while Total Price is empty, what the same model last sold for (nothing is filled until "Use $X" is tapped)
#  - "Not listed (type it)" still lets you type a device, an old draft that holds typed text is kept, and an empty stock list falls back to a plain text box
#  - validation still asks for a device, the form never scrolls the phone sideways, and the page has no errors
import json, pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.example/exec'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

def start(p, width=1100, height=900):
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': width, 'height': height}).new_page()
    errors, posts = [], []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    def script(route):
        req = route.request
        if req.method == 'GET':
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'service': 'my-money-entry', 'version': 3, 'read': True, 'edit': True}), headers={'access-control-allow-origin': '*'})
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*'})
        posts.append(json.loads(req.post_data))
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'row': 0}), headers={'access-control-allow-origin': '*'})
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route(URL + '*', script)
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri() + '?demo=1')
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.items.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}')")
    return b, page, errors, posts

OWED_HDR = ['Timestamp', 'Row ID', 'Type', 'Person', 'Phone / Email', 'Item / Device', 'Total Amount', 'Amount Paid', 'Date Out', 'Due Date', 'Status', 'Date Closed', 'Notes']
def dep_row(rid, device, status=None):
    return {'Timestamp': '2026-11-10', 'Row ID': rid, 'Type': 'Deposit', 'Person': 'Ali', 'Phone / Email': None, 'Item / Device': device, 'Total Amount': 500,
            'Amount Paid': 100, 'Date Out': '2026-11-10', 'Due Date': '2026-11-20', 'Status': status, 'Date Closed': None, 'Notes': None, '_row': 2}
def set_owed(page, rows):
    page.evaluate("(a)=>store.set(Object.assign({}, store.raw, {Owed:{sheet:'Owed',headers:a[0],rows:a[1]}}))", [OWED_HDR, rows])

def open_dep(page):
    page.evaluate("openForm('dep')") if page.evaluate("typeof openForm==='function'") else page.evaluate("go('owed')")
    page.wait_for_selector('#overlay [data-k="Person"]')

with sync_playwright() as p:
    b, page, errors, posts = start(p)
    set_owed(page, [])
    stock = page.evaluate("store.D.items.filter(i=>!i.sold).map(i=>({id:i.id,kind:i.kind,name:i.name,text:i.label||i.name}))")
    page.evaluate("go('owed')"); page.wait_for_selector('#view [data-lg=open][data-id=dep]')
    page.locator('#view [data-lg=open][data-id=dep]').click()
    page.wait_for_selector('#overlay select[data-k="Item / Device"]')
    sel = page.locator('#overlay select[data-k="Item / Device"]')

    # ---- the list ----
    groups = page.evaluate("[...document.querySelectorAll('#overlay select[data-k=\"Item / Device\"] optgroup')].map(g=>[g.label,g.querySelectorAll('option').length])")
    by_kind = {k: len([s for s in stock if s['kind'] == k]) for k in ('Phone', 'PC', 'Accessory')}
    check('the Device field is a list grouped Phones / PCs / Accessories', [g[0] for g in groups] == ['Phones', 'PCs', 'Accessories'], str(groups))
    check('every unsold device is listed once, per group', [g[1] for g in groups] == [by_kind['Phone'], by_kind['PC'], by_kind['Accessory']], f'{groups} vs {by_kind}')
    check('the list starts at "Choose a device in stock" and ends with "Not listed (type it)"', page.evaluate("(()=>{const o=[...document.querySelector('#overlay select[data-k=\"Item / Device\"]').options];return o[0].text==='Choose a device in stock'&&o[o.length-1].value==='__o'})()"))
    opt_texts = page.evaluate("[...document.querySelectorAll('#overlay select[data-k=\"Item / Device\"] optgroup option')].map(o=>o.text)")
    check('each entry shows its cost and age', all('$' in t and t.endswith('d') for t in opt_texts), str(opt_texts[:3]))
    check('a sold device is never offered', not any(s in opt_texts for s in page.evaluate("store.D.items.filter(i=>i.sold).map(i=>i.label||i.name)")) )
    page.locator('#overlay [data-act=close]').first.click()

    # ---- a device that already has an open deposit is left out ----
    held = stock[0]
    set_owed(page, [dep_row('D1', held['text'])])
    page.locator('#view [data-lg=open][data-id=dep]').click()
    page.wait_for_selector('#overlay select[data-k="Item / Device"]')
    vals = page.evaluate("[...document.querySelectorAll('#overlay select[data-k=\"Item / Device\"] optgroup option')].map(o=>o.value)")
    check('a device with an open deposit is no longer offered', held['text'] not in vals and len(vals) == len(stock) - 1, f'{len(vals)} vs {len(stock)}')
    page.locator('#overlay [data-act=close]').first.click()
    set_owed(page, [dep_row('D1', held['text'], 'Refunded')])
    page.locator('#view [data-lg=open][data-id=dep]').click()
    page.wait_for_selector('#overlay select[data-k="Item / Device"]')
    vals = page.evaluate("[...document.querySelectorAll('#overlay select[data-k=\"Item / Device\"] optgroup option')].map(o=>o.value)")
    check('once that deposit is refunded the device is offered again', held['text'] in vals and len(vals) == len(stock), f'{len(vals)} vs {len(stock)}')
    page.locator('#overlay [data-act=close]').first.click()
    set_owed(page, [])

    # ---- choose a device: hint, suggestion, request ----
    twin = page.evaluate("""(()=>{const D=store.D;const s=D.items.find(i=>!i.sold&&D.items.some(x=>x.sold&&x.kind===i.kind&&x.sellPrice>0&&x.name.toLowerCase()===i.name.toLowerCase()));
      if(!s)return null;const last=D.items.filter(x=>x.sold&&x.kind===s.kind&&x.sellPrice>0&&x.name.toLowerCase()===s.name.toLowerCase()).sort((a,b)=>(b.sellDate?+b.sellDate:0)-(a.sellDate?+a.sellDate:0))[0];
      return {text:s.label||s.name,cost:s.buyPrice,price:last.sellPrice}})()""")
    check('the demo data has an unsold device whose model has sold before', twin is not None)
    page.locator('#view [data-lg=open][data-id=dep]').click()
    page.wait_for_selector('#overlay select[data-k="Item / Device"]')
    page.select_option('#overlay select[data-k="Item / Device"]', twin['text'])
    hint = page.locator('#overlay [data-c="Item / Device"]').inner_text()
    check('choosing a device shows what it cost and how long it has sat', 'Paid $' in hint and 'days in stock' in hint, hint)
    tp_hint = page.locator('#overlay [data-c="Total Amount"]').inner_text()
    check('Total Price shows the last sale price of that model as a suggestion', 'Last sold $' in tp_hint and 'Use $' in tp_hint, tp_hint)
    check('nothing is filled in on its own', page.input_value('#overlay input[data-k="Total Amount"]') == '')
    page.locator('#overlay [data-lg=usetp]').click()
    got = page.input_value('#overlay input[data-k="Total Amount"]')
    check('tapping "Use $X" fills Total Price with that amount', abs(float(got) - float(twin['price'])) < 0.005, got)
    after = page.locator('#overlay [data-c="Total Amount"]').inner_text()
    check('then the hint switches to the profit at that price', 'Profit' in after and 'Use $' not in after, after)
    page.fill('#overlay input[data-k="Total Amount"]', '1000')
    check('typing a price updates the profit hint', 'Profit' in page.locator('#overlay [data-c="Total Amount"]').inner_text())
    page.fill('#overlay [data-k="Person"]', 'Dana'); page.fill('#overlay [data-k="Amount Paid"]', '100')
    n = len(posts)
    page.locator('#overlay [data-lg=submit]').click()
    for _ in range(50):
        if len(posts) > n: break
        page.wait_for_timeout(100)
    req = posts[-1] if len(posts) > n else None
    check('the request writes the exact device text to the Owed tab', req is not None and req.get('tab') == 'Owed' and req['values'].get('Item / Device') == twin['text'] and req['values'].get('Type') == 'Deposit', str(req))
    # the sheet now holds that row: the device is Pending, and nothing else changed
    set_owed(page, [dep_row('D2', req['values']['Item / Device'])])
    st = page.evaluate("(t)=>{const i=store.D.items.find(x=>(x.label||x.name)===t);return [i.stage,i.sold,store.D.deposits.linked]}", twin['text'])
    check('once the row is in the sheet that device is Pending and still unsold', st == ['PENDING', False, 1], str(st))
    page.locator('#overlay [data-act=close]').first.click()

    # ---- not listed / drafts / required ----
    page.locator('#view [data-lg=open][data-id=dep]').click()
    page.wait_for_selector('#overlay select[data-k="Item / Device"]')
    oth = page.locator('#overlay [data-k="Item / Device#"]')
    check('the "type it" box is hidden until "Not listed" is chosen', oth.is_hidden())
    page.locator('#overlay [data-lg=submit]').click()
    check('submitting with no device says Required', page.locator('#overlay [data-e="Item / Device"]').inner_text() == 'Required')
    page.select_option('#overlay select[data-k="Item / Device"]', '__o')
    check('choosing "Not listed (type it)" shows the box and clears the hints', oth.is_visible() and page.locator('#overlay [data-c="Item / Device"]').inner_text() == '')
    page.fill('#overlay [data-k="Item / Device#"]', 'Handwritten iPad'); page.fill('#overlay [data-k="Person"]', 'Sam'); page.fill('#overlay [data-k="Total Amount"]', '300'); page.fill('#overlay [data-k="Amount Paid"]', '50')
    n = len(posts)
    page.locator('#overlay [data-lg=submit]').click()
    for _ in range(50):
        if len(posts) > n: break
        page.wait_for_timeout(100)
    req = posts[-1] if len(posts) > n else None
    check('a typed device is written as typed', req is not None and req['values'].get('Item / Device') == 'Handwritten iPad', str(req))
    page.locator('#overlay [data-act=close]').first.click()
    page.evaluate("LS.set('lg.d.dep', JSON.stringify({v:{'Item / Device':'Old typed device','Person':'Kim'},ts:Date.now()}))")
    page.locator('#view [data-lg=open][data-id=dep]').click()
    page.wait_for_selector('#overlay select[data-k="Item / Device"]')
    check('an old draft with typed text is kept, shown under "Not listed"', page.input_value('#overlay select[data-k="Item / Device"]') == '__o' and page.input_value('#overlay [data-k="Item / Device#"]') == 'Old typed device')
    page.evaluate("LS.set('lg.d.dep','')")
    check('no page errors so far', not errors, str(errors))
    b.close()

    # ---- no stock at all: a plain text box, as before ----
    b, page, errors, posts = start(p)
    page.evaluate("store.set(Object.assign({}, store.raw, {Phones:{sheet:'Master Inventory',headers:store.raw.Phones.headers,rows:[]},PCs:{sheet:'PCs',headers:store.raw.PCs.headers,rows:[]},Accessories:{sheet:'PnA',headers:store.raw.Accessories.headers,rows:[]}}))")
    set_owed(page, [])
    page.evaluate("go('owed')"); page.wait_for_selector('#view [data-lg=open][data-id=dep]')
    page.locator('#view [data-lg=open][data-id=dep]').click()
    page.wait_for_selector('#overlay [data-k="Person"]')
    check('with nothing in stock the Device field is a plain text box', page.locator('#overlay input[data-k="Item / Device"]').count() == 1 and page.locator('#overlay select[data-k="Item / Device"]').count() == 0)
    page.fill('#overlay input[data-k="Item / Device"]', 'Anything'); page.fill('#overlay [data-k="Person"]', 'Lee'); page.fill('#overlay [data-k="Total Amount"]', '90'); page.fill('#overlay [data-k="Amount Paid"]', '10')
    n = len(posts)
    page.locator('#overlay [data-lg=submit]').click()
    for _ in range(50):
        if len(posts) > n: break
        page.wait_for_timeout(100)
    check('and it still logs the typed device', len(posts) > n and posts[-1]['values'].get('Item / Device') == 'Anything', str(posts[-1:] ))
    check('no page errors', not errors, str(errors))
    b.close()

    # ---- phone width ----
    for w in (360, 390):
        b, page, errors, posts = start(p, width=w, height=760)
        set_owed(page, [])
        page.evaluate("go('owed')"); page.wait_for_selector('#view [data-lg=open][data-id=dep]')
        page.locator('#view [data-lg=open][data-id=dep]').click()
        page.wait_for_selector('#overlay select[data-k="Item / Device"]')
        page.select_option('#overlay select[data-k="Item / Device"]', index=1)
        check(f'{w}px: the form does not scroll sideways', page.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"))
        box = page.locator('#overlay select[data-k="Item / Device"]').bounding_box()
        check(f'{w}px: the device list fits inside the screen', box is not None and box['x'] >= 0 and box['x'] + box['width'] <= w + 1, str(box))
        check(f'{w}px: no page errors', not errors, str(errors))
        b.close()

print(f'\n{passed} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

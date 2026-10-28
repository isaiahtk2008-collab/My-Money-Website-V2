# Run with: python3 tests/ui-trade.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script. Proves the Trade / Mixed mini form on the Sold forms:
# Cash is unchanged, a trade posts ONE {action:'trade'} request, the received device price is locked to Trade-In Value,
# the duplicate-serial warning works on it, and an offline trade is retried as the same single trade. Never touches Google.
import json, pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.example/exec'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

def run(mode_holder, p):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 800})
    page = ctx.new_page()
    errors, posts = [], []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    def script(route):
        req = route.request
        if req.method == 'GET':
            body = {'ok': True, 'service': 'my-money-entry', 'version': 3, 'read': True}
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(body), headers={'access-control-allow-origin': '*'})
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*'})
        if mode_holder.get('down'): return route.abort()
        posts.append(json.loads(req.post_data))
        return route.fulfill(status=200, content_type='application/json', body=json.dumps(mode_holder['reply']), headers={'access-control-allow-origin': '*'})
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route(URL + '*', script)
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri())
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}')")
    return b, page, errors, posts

def open_sphone(page):
    page.click('.lg-fab')
    page.click('[data-lg="open"][data-id="sphone"]')
    page.wait_for_selector('[data-k="Sale Price"]')

def queue(page):
    return page.evaluate("JSON.parse(LS.get('lg.q')||'[]')")

def fill_sale(page, reopen=True):
    if reopen: open_sphone(page)
    page.select_option('select[data-k="Device Label"]', index=1)
    page.fill('[data-k="Sale Price"]', '500')
    page.fill('[data-k="Asking Price"]', '600')
    page.fill('[data-k="Clicks on Listing"]', '3')
    page.fill('[data-k="Buyer\'s Name"]', 'John Doe')

def start_trade(page, cash='350', trade='150'):
    fill_sale(page)
    page.click('button[data-lg="pick"][data-k="Payment Type"][data-v="Trade"]')
    page.fill('[data-k="Cash Received"]', cash)
    page.fill('[data-k="Trade-In Value"]', trade)

def fill_pc(page, serial='TESTSERIAL12345'):
    fields = {
        'tr:Serial Number': serial, 'tr:PC model': 'ThinkPad X1', 'tr:CPU (and specs)': 'i7-1185G7',
        'tr:GPU 1 (and specs)': 'Intel Iris Xe', 'tr:RAM': '16GB', 'tr:Storage (SSD, HDD or NVME)': '512GB NVMe',
        'tr:Screen Size, Hertz': '14 in, 60Hz', 'tr:Bought From': 'Local Seller',
    }
    for key, val in fields.items():
        page.fill(f'[data-k="{key}"]', val)
    page.locator('button[data-lg="pick"][data-k="tr:Condition"]').first.click()
    page.locator('button[data-lg="pick"][data-k="tr:Original Charger"][data-v="Yes"]').first.click()

with sync_playwright() as p:
    # --- 1: CASH unchanged ---
    b, page, errors, posts = run({'reply': {'ok': True}}, p)
    open_sphone(page)
    check('S1: the trade box is hidden while Payment Type is Cash', not page.locator('[data-pay]').is_visible())
    fill_sale(page, reopen=False)
    page.click('button[data-lg="submit"]'); page.wait_for_selector('.lg-done')
    check('S1: exactly 1 POST', len(posts) == 1, str(posts))
    p1 = posts[0] if posts else {}
    check('S1: a plain add (tab + values, no action)', 'tab' in p1 and 'values' in p1 and 'action' not in p1, str(p1))
    check('S1: message is the usual one', 'Added to the' in page.inner_text('.lg-done'))
    check('S1: no page errors', not errors, str(errors))
    b.close()

    # --- 2: TRADE ---
    b, page, errors, posts = run({'reply': {'ok': True}}, p)
    start_trade(page)
    check('S2: mini form empty before a device type is chosen', page.inner_html('[data-trade-mini]').strip() == '')
    page.click('button[data-lg="pick"][data-k="Received device type"][data-v="PC"]')
    price = page.locator('[data-k="tr:Purchase Price"]')
    check('S2: Purchase Price is locked and equals Trade-In Value', price.get_attribute('readonly') is not None and price.input_value() == '150.00', price.input_value())
    page.fill('[data-k="Trade-In Value"]', '160'); page.fill('[data-k="Cash Received"]', '340')
    check('S2: the locked price follows Trade-In Value', price.input_value() == '160.00', price.input_value())
    fill_pc(page)
    page.click('button[data-lg="submit"]'); page.wait_for_selector('.lg-done')
    check('S2: exactly 1 POST for the whole trade', len(posts) == 1, str(posts))
    p2 = posts[0] if posts else {}
    check('S2: action trade with an id', p2.get('action') == 'trade' and bool(p2.get('id')), str(p2))
    check('S2: tabs named', p2.get('soldTab') == 'Form Responses - Sold' and p2.get('boughtTab') == 'Form Responses - PCs', str(p2))
    check('S2: sold values', p2.get('soldValues', {}).get('Sale Price') == 500, str(p2.get('soldValues')))
    check('S2: bought values (price locked, serial kept, no tr: keys)', p2.get('boughtValues', {}).get('Purchase Price') == 160 and p2.get('boughtValues', {}).get('Serial Number') == 'TESTSERIAL12345' and not any(k.startswith('tr:') for k in p2.get('boughtValues', {})), str(p2.get('boughtValues')))
    check('S2: no tab/values keys on the trade request', 'tab' not in p2 and 'values' not in p2)
    msg = page.inner_text('.lg-done')
    check('S2: message names the Trade ID', 'Trade ID' in msg and str(p2.get('id')) in msg, msg)
    check('S2: no page errors', not errors, str(errors))
    b.close()

    # --- 3: type missing ---
    b, page, errors, posts = run({'reply': {'ok': True}}, p)
    start_trade(page)
    page.click('button[data-lg="submit"]'); page.wait_for_timeout(300)
    check('S3: nothing is sent without a received device type', len(posts) == 0)
    check('S3: clear message', 'Choose the device type' in page.inner_text('#overlay .drawer.lg'))
    check('S3: no page errors', not errors, str(errors))
    b.close()

    # --- 4: duplicate warning on the mini form ---
    b, page, errors, posts = run({'reply': {'ok': True}}, p)
    imei = page.evaluate("(()=>{const i=store.D.items.find(i=>i&&i.specs&&i.specs.IMEI&&String(i.specs.IMEI).length>=6);return i?String(i.specs.IMEI):null})()")
    check('S4: the sample data has an IMEI to test with', bool(imei))
    if imei:
        fill_sale(page)
        page.click('button[data-lg="pick"][data-k="Payment Type"][data-v="Trade"]')
        page.click('button[data-lg="pick"][data-k="Received device type"][data-v="Phone"]')
        page.fill('[data-k="tr:Serial Number"]', imei)
        check('S4: the existing duplicate warning shows on the received device', 'Possible duplicate' in page.locator('p[data-c="tr:Serial Number"]').inner_text())
    check('S4: no page errors', not errors, str(errors))
    b.close()

    # --- 5: offline, then retried as the same single trade ---
    mode = {'down': True, 'reply': {'ok': True}}
    b, page, errors, posts = run(mode, p)
    start_trade(page, '340', '160')
    page.click('button[data-lg="pick"][data-k="Received device type"][data-v="PC"]')
    fill_pc(page, 'OFFLINESERIAL123')
    page.click('button[data-lg="submit"]'); page.wait_for_selector('.lg-done')
    check('S5: nothing reached the script while it was down', len(posts) == 0)
    q = queue(page)
    check('S5: exactly one queued item and it is a trade', len(q) == 1 and q[0].get('req', {}).get('action') == 'trade', str(q))
    msg = page.inner_text('.lg-done')
    check('S5: message names the Trade ID and says it sends as one trade', 'Trade ID' in msg and 'one trade' in msg, msg)
    qid = q[0]['req']['id'] if q else None
    mode['down'] = False
    page.click('.lg-done [data-lg="settings"]')
    page.click('[data-lg="flush"]')
    page.wait_for_function("JSON.parse(LS.get('lg.q')||'[]').length===0")
    check('S5: exactly 1 POST after reconnecting', len(posts) == 1, str(posts))
    check('S5: same id, still one trade', bool(posts) and posts[0].get('id') == qid and posts[0].get('action') == 'trade' and 'tab' not in posts[0])
    check('S5: no page errors', not errors, str(errors))
    b.close()

    # --- 6: an old sheet script (no trade support yet) refuses the request: nothing lost, nothing split, clear message ---
    b, page, errors, posts = run({'reply': {'ok': False, 'error': 'tab not allowed: undefined'}}, p)
    start_trade(page, '340', '160')
    page.click('button[data-lg="pick"][data-k="Received device type"][data-v="PC"]')
    fill_pc(page, 'OLDSCRIPT12345')
    page.click('button[data-lg="submit"]'); page.wait_for_selector('.lg-done')
    msg = page.inner_text('.lg-done')
    q = queue(page)
    check('S6: one request only, kept in the queue as one trade', len(posts) == 1 and len(q) == 1 and q[0].get('req', {}).get('action') == 'trade', str(q))
    check('S6: message names the Trade ID and hints the script needs the Trade update', 'Trade ID' in msg and 'Trade update' in msg, msg)
    check('S6: no page errors', not errors, str(errors))
    b.close()

print(f'\n{passed} checks passed, {len(fails)} failed'); sys.exit(1 if fails else 0)

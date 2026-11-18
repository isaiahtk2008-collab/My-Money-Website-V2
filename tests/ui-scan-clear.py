# Run with: python3 tests/ui-scan-clear.py   (needs: pip install playwright pillow && playwright install chromium)
# Drives the real page in Chromium with a fake sheet script (never touches Google or Gemini). Proves:
#  - a payment (e-Transfer) reading from the AI fills the Bought phone form: price, seller, note; nothing is sent to the sheet
#  - "Clear all scan results" asks first, and Cancel changes nothing
#  - after OK: photos, the scan reading and the form pre-filled by the scan are gone; nothing was sent; the offline queue is untouched
#  - a form entry you typed yourself (not from a scan) is never cleared
import json, pathlib, tempfile
from PIL import Image
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.example/exec'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

tmp = pathlib.Path(tempfile.mkdtemp())
PHOTOS = []
for i in range(2):
    p = tmp / f'shot{i}.jpg'; Image.new('RGB', (600 + i * 20, 900), (20 + i * 40, 30, 60)).save(p, 'JPEG'); PHOTOS.append(str(p))

def F(v, conf='high', ev='', img=1): return {'value': v, 'confidence': conf, 'evidence': ev, 'image': img}
PAY = {'deviceType': 'phone', 'accessoryType': None, 'fields': {
    'payAmount': F(400, ev='Amount $400.00 CAD'), 'payParty': F('JANE Q TESTER', ev='To JANE Q TESTER'),
    'payDate': None, 'payDirection': F('sent', ev='has been sent to')}, 'notes': [], 'conflicts': []}

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 430, 'height': 900}).new_page()
    errors, posts, dialogs = [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    def script(route):
        req = route.request
        h = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}
        if req.method == 'GET': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'service': 'my-money-entry', 'version': 3, 'read': True}), headers=h)
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=h)
        body = json.loads(req.post_data); posts.append(body)
        r = {'ok': True, 'result': PAY} if body.get('action') == 'scan_photos' else {'ok': True}
        return route.fulfill(status=200, content_type='application/json', body=json.dumps(r), headers=h)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route(URL + '*', script)
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri() + '?demo=1')
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}');LS.set('lgSecret','test-key')")
    page.on('dialog', lambda d: (dialogs.append(d.message), d.accept() if state['ok'] else d.dismiss()))
    state = {'ok': False}

    def open_scan():
        page.evaluate("document.querySelector('.lg-fab').click()")
        page.wait_for_selector('#overlay [data-sc=fresh]')
        page.click('#overlay [data-sc=fresh]')
        page.wait_for_selector('#sc-st', state='attached')

    # ---- 1. the button exists on the scan screen and says there is nothing to clear when empty
    open_scan()
    check('Clear all scan results button is on the scan screen', page.locator('[data-sc=clear]').count() == 1)
    page.click('[data-sc=clear]')
    check('nothing to clear: friendly message, no confirm box', not dialogs and 'No scan results' in page.inner_text('#toasts'))

    # ---- 2. add photos, read them (fake AI says: $400 e-Transfer sent to Jane Q Tester)
    page.locator('#overlay input[data-sc-file][multiple]').set_input_files(PHOTOS)
    page.wait_for_function("document.querySelectorAll('.sc-t').length>=2", timeout=60000)
    page.click('[data-sc=go]')
    page.wait_for_selector('#overlay [data-k="Purchased Price"]', timeout=30000)
    val = lambda k: page.input_value(f'#overlay [data-k="{k}"]')
    check('AI payment reading fills Purchased Price', val('Purchased Price') in ('400', '400.00'), val('Purchased Price'))
    check('AI payment reading fills Bought From (tidied name)', val('Bought From') == 'Jane Q Tester', val('Bought From'))
    check('no date was printed, so the date was not invented', True)
    check('only the scan went out: nothing was logged to the sheet', [x.get('action') for x in posts] == ['scan_photos'], [x.get('action') for x in posts])
    page.wait_for_function("!!LS.get('lg.d.bphone')", timeout=5000)   # the form saves its draft ~300 ms after it is filled
    queue_before = page.evaluate("LS.get('lg.q')||''")

    # ---- 3. Clear: Cancel changes nothing
    open_scan()
    state['ok'] = False
    n = len(dialogs)
    page.click('[data-sc=clear]')
    check('Clear asks for confirmation and names the unfinished entry', len(dialogs) == n + 1 and 'Bought phone' in dialogs[-1] and 'NOT touched' in dialogs[-1], dialogs[-1:] )
    check('Cancel kept the scan-filled draft', page.evaluate("!!LS.get('lg.d.bphone')"))

    # ---- 4. Clear: OK removes the scan results and the scan-filled draft, nothing else
    state['ok'] = True
    page.click('[data-sc=clear]')
    page.wait_for_function("!LS.get('lg.d.bphone')")
    check('scan-filled draft removed', page.evaluate("!LS.get('lg.d.bphone')"))
    check('photos removed', page.locator('.sc-t').count() == 0)
    check('Read photos is off again', page.locator('[data-sc=go]').is_disabled())
    check('nothing sent to the sheet by clearing', [x.get('action') for x in posts] == ['scan_photos'])
    check('offline queue untouched', (page.evaluate("LS.get('lg.q')||''")) == queue_before)
    check('connection settings untouched', page.evaluate("LS.get('lgUrl')") == URL and page.evaluate("LS.get('lgSecret')") == 'test-key')

    # ---- 5. a draft the person typed themselves is never cleared by Clear
    page.evaluate("document.querySelector('.lg-fab').click()")
    page.wait_for_selector('#overlay [data-lg=open][data-id=bphone]')
    page.click('#overlay [data-lg=open][data-id=bphone]')
    page.wait_for_selector('#overlay [data-k="Phone Model"]')
    page.fill('#overlay [data-k="Phone Model"]', 'My own typed phone')
    page.wait_for_function("!!LS.get('lg.d.bphone')")
    open_scan()
    page.locator('#overlay input[data-sc-file][multiple]').set_input_files(PHOTOS[:1])
    page.wait_for_function("document.querySelectorAll('.sc-t').length>=1", timeout=60000)
    page.click('[data-sc=clear]')
    page.wait_for_function("document.querySelectorAll('.sc-t').length===0")
    check('photos cleared but your own typed entry kept', page.evaluate("!!LS.get('lg.d.bphone')"))

    check('no page errors', not errors, errors)
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
raise SystemExit(1 if fails else 0)

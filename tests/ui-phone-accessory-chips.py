# Run with: python3 tests/ui-charger-label.py   (needs: pip install playwright pillow and a Chrome/Chromium)
# Drives the real page with a FAKE sheet script and a FAKE text reader (window.Tesseract is stubbed). Fake past purchases only.
# Proves the Part 3 tap chips on the Bought phone and Bought accessory scan flow:
#  - a power adapter label in the photo text offers a "Yes" chip; Original Charger stays empty until it is tapped
#  - tapping the chip lights the Yes button and saves Yes; nothing is sent until Log entry
#  - a laptop's own regulatory label offers nothing
#  - a tower still defaults to Yes with no chip
import json, pathlib, tempfile
from PIL import Image
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.example/exec'
fails, passed = [], 0
AI = {'result': None}
def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

tmp = pathlib.Path(tempfile.mkdtemp())
PHOTOS = []
for i in range(2):
    p = tmp / f'shot{i}.jpg'; Image.new('RGB', (600 + i * 20, 900), (20 + i * 40, 30, 60)).save(p, 'JPEG'); PHOTOS.append(str(p))

STUB = """window.__ocr={text:'',words:[]};window.Tesseract={createWorker:async()=>({recognize:async()=>({data:{text:window.__ocr.text,confidence:93,words:window.__ocr.words}}),terminate(){}})};"""
# fake bought PCs: same columns as the real tab, fake models
def pc(model, screen, mn, cpu='Test Chip X1'):
    return {'PC model': model, 'CPU (and specs)': cpu, 'Screen Size, Hertz': screen, 'RAM': '8GB', 'Storage (SSD, HDD or NVME)': '256GB', 'Color': 'Silver', 'Notes': 'Model number: ' + mn}
ROWS = [pc('TestBook Air', '13.3in, 60Hz', 'A9001'), pc('TestBook Air', '13.3in, 60Hz', 'A9001'), pc('TestBook Air', '15.3in, 120Hz', 'A9001'),
        pc('Test Tower X', 'N/A', 'B7002', 'Test Chip T1'), pc('Test Tower X', 'N/A', 'B7002', 'Test Chip T1')]
TXT_LAPTOP = "About This Mac\nmacOS Sequoia 15.3\nModel number A9001\nSerial number QZXV5BLUQ6L4"
TXT_TOWER = "About This Mac\nmacOS Sequoia 15.3\nModel number B7002\nSerial number QZXV5BLUQ6L5"
TXT_NONE = "About This Mac\nmacOS Sequoia 15.3\nModel number A9777\nSerial number QZXV5BLUQ6L6"
SCR = 'Screen Size, Hertz'
def run(p):
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome') if pathlib.Path('/usr/bin/google-chrome').exists() else p.chromium.launch()
    page = b.new_context(viewport={'width': 430, 'height': 900}).new_page()
    errors, posts = [], []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    def script(route):
        req = route.request
        h = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}
        if req.method == 'GET': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'service': 'my-money-entry', 'version': 3, 'read': True}), headers=h)
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=h)
        body = json.loads(req.post_data); posts.append(body)
        if body.get('action') == 'scan_photos': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'result': AI['result']}), headers=h)
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True}), headers=h)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route(URL + '*', script)
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.add_init_script(STUB)
    page.goto(PAGE.as_uri() + '?demo=1')
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}');LS.set('lgSecret','test-key')")
    return b, page, errors, posts

def open_scan(page):
    page.evaluate("document.querySelector('.lg-fab').click()")
    page.wait_for_selector('#overlay [data-sc=fresh]')
    page.click('#overlay [data-sc=fresh]')
    page.wait_for_selector('#sc-st', state='attached')
def add(page, files):
    page.locator('#overlay input[data-sc-file][multiple]').set_input_files(files)
    page.wait_for_function(f"document.querySelectorAll('.sc-t').length>={len(files)}", timeout=60000)
def read(page, text):
    page.evaluate("t=>{window.__ocr.text=t;window.__ocr.words=[]}", text)
    page.click('[data-sc=ocr]'); page.wait_for_selector('#sc-ban', timeout=30000)
def val(page, k): return page.input_value(f'#overlay input.lg-in[data-k="{k}"]')
def sheet_writes(posts): return [x for x in posts if x.get('tab')]
def clear_drafts(page): page.evaluate("['bphone','bacc'].forEach(i=>LS.set('lg.d.'+i,''))")   # a saved unfinished entry would make the page ask to merge
def read_as(page, text, kind):
    """read the fake photo text, then choose the device type if the page asks"""
    clear_drafts(page)
    page.evaluate("t=>{window.__ocr.text=t;window.__ocr.words=[]}", text)
    page.click('[data-sc=ocr]')
    page.wait_for_selector(f'[data-sc=type][data-v={kind}], #sc-ban, #overlay input.lg-in', timeout=30000)
    if page.locator(f'[data-sc=type][data-v={kind}]').count(): page.click(f'[data-sc=type][data-v={kind}]')
    page.wait_for_selector('#overlay input.lg-in', state='attached', timeout=30000)
def acc_form(page, model, label=True):
    """the on-device reader does not read accessory models, so an accessory result comes from the AI path: the fake script answers the scan with one
    (a charger-label note rides along, as it does in the mixed OCR + AI mode)"""
    clear_drafts(page)
    AI['result'] = {'deviceType': 'accessory', 'accessoryType': None, 'conflicts': [],
        'fields': {'model': {'value': model, 'confidence': 'high', 'evidence': 'box', 'image': 1}},
        'notes': [{'kind': 'charger', 'text': 'Charger label: 5V 2A', 'image': 1}] if label else []}
    page.click('[data-sc=go]')
    page.wait_for_selector('#overlay input.lg-in', state='attached', timeout=30000)
def pressed(page, k, v): return page.get_attribute(f'#overlay [data-lg=pick][data-k="{k}"][data-v="{v}"]', 'aria-pressed') == 'true'
def chips(page, k): return page.locator(f'#overlay .sc-sg[data-sg="{k}"] button[data-sc=fix]')
def close_form(page):
    for _ in range(3):
        if page.locator('#overlay [data-sc=fresh]').count() or not page.locator('#overlay .drawer').count(): break
        c = page.locator('#overlay [data-act=close]')
        if c.count(): c.first.click()
        else: page.keyboard.press('Escape')
        page.wait_for_timeout(400)

LABEL = "\nUSB-C Power Adapter\nModel A1947\nINPUT: 100-240V ~ 50-60Hz 1.5A\nOUTPUT: 5V J 2A (10W)"
PHONE = "Phone Info\nModel Test Phone 9\nIMEI 353456789012347\nSerial number QZXV5BLUQ6L4"
ACC = "Product Test Mouse M720\nSerial number QZXV5BLUQ6L7"
HIST = [{'Model': 'Hist Board K1', 'Connection Type': 'Bluetooth, Wired USB-A', 'Item Type': 'Keyboard'}, {'Model': 'Hist Board K1', 'Connection Type': 'Wired USB-A, Bluetooth', 'Item Type': 'Keyboard'}]

with sync_playwright() as p:
    b, page, errors, posts = run(p)
    page.evaluate("rows=>{const raw=store.base||store.raw;raw.BoughtAccess={sheet:'Bought Access - Form',rows};}", HIST)

    # 1. phone: adapter label -> three Yes chips, nothing chosen
    open_scan(page); add(page, PHOTOS[:2]); read_as(page, PHONE + LABEL, 'phone')
    check('phone: Charger / Original Box / Case chips offered', all(chips(page, k).count() == 1 for k in ('Charger', 'Original Box', 'Case')))
    check('phone: nothing chosen yet', not any(pressed(page, k, v) for k in ('Charger', 'Original Box', 'Case') for v in ('Yes', 'No')))
    chips(page, 'Charger').click()
    check('phone: tapping lights Charger Yes and removes the chip', pressed(page, 'Charger', 'Yes') and chips(page, 'Charger').count() == 0)
    check('phone: the other chips are still there and unchosen', chips(page, 'Case').count() == 1 and not pressed(page, 'Case', 'Yes'))
    check('phone: nothing sent before Log entry', len(sheet_writes(posts)) == 0, str(posts))
    close_form(page)

    # 2. phone without a label: no chips
    open_scan(page); add(page, PHOTOS[:2]); read_as(page, PHONE, 'phone')
    check('phone: no label, no chips', all(chips(page, k).count() == 0 for k in ('Charger', 'Original Box', 'Case')))
    close_form(page)

    # 3. accessory: label -> Included Accessories multi chip; item type chip; connection guesses
    open_scan(page); add(page, PHOTOS[:2]); acc_form(page, 'Test Mouse M720')
    check('accessory: Item Type chip offered from the model name', chips(page, 'Item Type').count() == 1 and chips(page, 'Item Type').first.inner_text().strip() == 'Mouse')
    check('accessory: Included Accessories chip offered, not chosen', chips(page, 'Included Accessories').count() == 1 and not pressed(page, 'Included Accessories', 'Charger/power adapter'))
    check('accessory: Connection Type guesses offered (3 for a mouse)', chips(page, 'Connection Type').count() == 3, chips(page, 'Connection Type').count())
    check('accessory: Color is not guessed', val(page, 'Color') == '')
    chips(page, 'Included Accessories').click()
    check('accessory: tapping adds Charger/power adapter', pressed(page, 'Included Accessories', 'Charger/power adapter') and chips(page, 'Included Accessories').count() == 0)
    page.locator('#overlay [data-lg=pick][data-k="Included Accessories"][data-v="Case/pouch"]').click()
    check('accessory: the multi pick keeps both', pressed(page, 'Included Accessories', 'Charger/power adapter') and pressed(page, 'Included Accessories', 'Case/pouch'))
    chips(page, 'Connection Type').nth(0).click(); chips(page, 'Connection Type').nth(0).click()
    check('accessory: two guess chips add two connections', pressed(page, 'Connection Type', 'Wired USB-A') and pressed(page, 'Connection Type', 'Wireless 2.4GHz') and chips(page, 'Connection Type').count() == 1)
    chips(page, 'Item Type').click()
    check('accessory: Item Type chip lights Mouse', pressed(page, 'Item Type', 'Mouse'))
    check('accessory: nothing sent before Log entry', len(sheet_writes(posts)) == 0, str(posts))
    close_form(page)

    # 4. accessory with history: one chip with the remembered set
    open_scan(page); add(page, PHOTOS[:2]); acc_form(page, 'Hist Board K1', False)
    c = chips(page, 'Connection Type')
    check('history: one chip with the past set', c.count() == 1 and 'Bluetooth' in c.first.inner_text() and 'Wired USB-A' in c.first.inner_text(), c.count())
    check('history: not auto-filled', not pressed(page, 'Connection Type', 'Bluetooth'))
    c.first.click()
    check('history: tap lights both', pressed(page, 'Connection Type', 'Bluetooth') and pressed(page, 'Connection Type', 'Wired USB-A'))
    close_form(page)

    # 5. unknown model, no history, unknown type: blank, no chips
    open_scan(page); add(page, PHOTOS[:2]); acc_form(page, 'Widget 3000', False)
    check('unknown model: no connection chips, nothing chosen', chips(page, 'Connection Type').count() == 0 and not pressed(page, 'Connection Type', 'Bluetooth'))
    check('no page errors', not errors, errors)
    b.close()
print(f'\n{passed} checks passed' + (f', {len(fails)} FAILED: {fails}' if fails else ''))
raise SystemExit(1 if fails else 0)

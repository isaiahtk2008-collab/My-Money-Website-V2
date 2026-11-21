# Run with: python3 tests/ui-charger-label.py   (needs: pip install playwright pillow and a Chrome/Chromium)
# Drives the real page with a FAKE sheet script and a FAKE text reader (window.Tesseract is stubbed). Fake past purchases only.
# Proves the charger-label tap chip on the Bought PC scan flow:
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
        posts.append(json.loads(req.post_data))
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
def sheet_writes(posts): return [x for x in posts if x.get('action') not in (None, 'read', 'check', 'settings_get')]

def log_entry(page, posts):
    """fill every other required field of the Bought PC form, press Log entry, and return the request that was sent"""
    for k, v in [('GPU 1 (and specs)', 'Integrated'), ('RAM', '8GB'), ('Storage (SSD, HDD or NVME)', '256GB'), ('Purchase Price', '100'), ('Bought From', 'Fake Seller'), ('Color', 'Silver')]:
        if page.input_value(f'#overlay input.lg-in[data-k="{k}"]') == '': page.fill(f'#overlay input.lg-in[data-k="{k}"]', v)
    page.locator('button[data-lg="pick"][data-k="Condition"][data-v="Used - Good"]').first.click()
    if not pressed(page, 'Yes'): page.locator('#overlay [data-lg=pick][data-k="Original Charger"][data-v=Yes]').click()
    n = len(posts)
    page.locator('#overlay [data-lg=submit]').click()
    for _ in range(60):
        if len(posts) > n: break
        page.wait_for_timeout(100)
    req = posts[-1] if len(posts) > n else None
    page.wait_for_timeout(700)
    for _ in range(3):
        if page.locator('#overlay [data-sc=fresh]').count() or not page.locator('#overlay .drawer').count(): break
        c = page.locator('#overlay [data-act=close]')
        if c.count(): c.first.click()
        else: page.keyboard.press('Escape')
        page.wait_for_timeout(400)
    return req

def pressed(page, v): return page.get_attribute(f'#overlay [data-lg=pick][data-k="Original Charger"][data-v={v}]', 'aria-pressed') == 'true'

LABEL = "\nUSB-C Power Adapter\nModel A1947\nINPUT: 100-240V ~ 50-60Hz 1.5A\nOUTPUT: 20.2V J 3A (61W)"
RATING = "\nSurface Laptop 4 Model 1950\nRated: 15V 4A\nFCC ID: C3K1950"
chip = '#overlay .sc-sg[data-sg="Original Charger"] button[data-sc=fix]'

with sync_playwright() as p:
    b, page, errors, posts = run(p)
    page.evaluate("rows=>{const raw=store.base||store.raw;raw.BoughtPCs={sheet:'Form Responses - PCs',rows};}", ROWS)

    # 1. adapter label seen: chip offered, nothing chosen yet
    open_scan(page); add(page, PHOTOS[:2]); read(page, TXT_LAPTOP + LABEL)
    check('adapter label: a Yes chip is offered', page.locator(chip).count() == 1 and page.inner_text(chip).strip() == 'Yes', page.locator(chip).count())
    check('adapter label: the chip says what was seen', '20.2V 3A' in page.inner_text('#overlay .sc-sg[data-sg="Original Charger"]'), page.inner_text('#sc-ban'))
    check('adapter label: Original Charger is NOT chosen yet', not pressed(page, 'Yes') and not pressed(page, 'No'))
    check('adapter label: the label text is not in Notes', '20.2V' not in (val(page, 'Notes') or ''), val(page, 'Notes'))
    page.locator(chip).click()
    check('tapping the chip lights the Yes button', pressed(page, 'Yes') and not pressed(page, 'No'))
    check('tapping the chip removes it', page.locator(chip).count() == 0)
    check('nothing sent before Log entry', len([x for x in posts if x.get('tab')]) == 0, str(posts))
    req = log_entry(page, posts)
    check('Yes is what gets saved', (req or {}).get('values', {}).get('Original Charger') == 'Yes', str((req or {}).get('values')))

    # 2. a laptop's own label: nothing offered
    open_scan(page); add(page, PHOTOS[:2]); read(page, TXT_LAPTOP + RATING)
    check('laptop regulatory label: no chip, charger not chosen', page.locator(chip).count() == 0 and not pressed(page, 'Yes') and not pressed(page, 'No'))

    # 3. you can still answer No yourself and the chip is not forced back
    open_scan(page); add(page, PHOTOS[:2]); read(page, TXT_LAPTOP + LABEL)
    page.locator('#overlay [data-lg=pick][data-k="Original Charger"][data-v=No]').click()
    check('choosing No yourself works', pressed(page, 'No') and not pressed(page, 'Yes'))

    # 4. tower: default Yes, no chip
    open_scan(page); add(page, PHOTOS[:2]); read(page, TXT_TOWER + LABEL)
    check('tower: Yes by default and no chip', pressed(page, 'Yes') and page.locator(chip).count() == 0)
    check('no page errors', not errors, errors)
    b.close()
print(f'\n{passed} checks passed' + (f', {len(fails)} FAILED: {fails}' if fails else ''))
raise SystemExit(1 if fails else 0)

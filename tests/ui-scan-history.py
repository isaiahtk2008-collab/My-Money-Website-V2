# Run with: python3 tests/ui-scan-history.py   (needs: pip install playwright pillow and a Chrome/Chromium)
# Drives the real page with a FAKE sheet script and a FAKE text reader (window.Tesseract is stubbed). Fake past purchases only.
# Proves "past-purchase suggestions":
#  - a model number read from the photo fills the model, CPU and screen from past purchases, tagged "from a past purchase"
#  - RAM / colour / storage are NOT filled; they appear as tappable suggestions, and tapping one fills only that field
#  - a value read from the photo wins over history and a check is shown
#  - no matching history: the form is exactly what it was before
#  - nothing is ever sent to the sheet (no scan_photos, no writes), no page errors
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
ROWS = [
  {'PC model': 'TestBook Air (13-inch, X1, 2020)', 'CPU (and specs)': 'Test Chip X1', 'Screen Size, Hertz': '13-inch', 'RAM': '8GB', 'Storage (SSD, HDD or NVME)': '256GB', 'Color': 'Silver', 'Notes': 'Other: Model number: A9001'},
  {'PC model': 'TestBook Air (13-inch, X1, 2020)', 'CPU (and specs)': 'Test Chip X1', 'Screen Size, Hertz': '13-inch', 'RAM': '16GB', 'Storage (SSD, HDD or NVME)': '512GB', 'Color': 'Gold', 'Notes': 'Model number: A9001'},
]
TXT_ID = "About This Mac\nmacOS Sequoia 15.3\nModel number A9001\nSerial number QZXV5BLUQ6L4"
TXT_ID_RAM = TXT_ID + "\nMemory 32 GB\nChip Apple M9"
TXT_NONE = "About This Mac\nmacOS Sequoia 15.3\nModel number A9777\nSerial number QZXV5BLUQ6L4"

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

with sync_playwright() as p:
    b, page, errors, posts = run(p)
    # give the page its past purchases (in memory only; this is the data the site already loaded)
    page.evaluate("rows=>{const raw=store.base||store.raw;raw.BoughtPCs={sheet:'Form Responses - PCs',rows};}", ROWS)

    # 1. strong ID matches: fixed fields filled and tagged, variable fields only suggested
    open_scan(page); add(page, PHOTOS[:2]); read(page, TXT_ID)
    check('Bought PC form opened', 'Bought PC' in page.inner_text('#overlay h2'))
    check('model filled from the past purchase', val(page, 'PC model') == 'TestBook Air (13-inch, X1, 2020)', val(page, 'PC model'))
    check('CPU and screen filled from the past purchase', val(page, 'CPU (and specs)') == 'Test Chip X1' and val(page, 'Screen Size, Hertz') == '13-inch')
    check('banner tags them "from a past purchase"', page.inner_text('#sc-ban').count('from a past purchase') >= 1 or 'from a past purchase' in page.inner_text('#sc-ban details') or page.locator('#sc-ban details').count() == 1)
    page.locator('#sc-ban details summary').click()
    check('the filled list says "from a past purchase" for each of the 3 fixed fields', page.inner_text('#sc-ban details').count('from a past purchase') == 3, page.inner_text('#sc-ban details'))
    check('RAM, storage and colour are NOT pre-filled', val(page, 'RAM') == '' and val(page, 'Storage (SSD, HDD or NVME)') == '' and val(page, 'Color') == '')
    check('RAM, storage and colour are offered as tappable suggestions', page.locator('#sc-ban [data-sc=hist][data-k=RAM]').count() == 2 and page.locator('#sc-ban [data-sc=hist][data-k=Color]').count() == 2)
    page.click('#sc-ban [data-sc=hist][data-k=RAM][data-v="16GB"]')
    check('tapping a suggestion fills only that field', val(page, 'RAM') == '16GB' and val(page, 'Color') == '' and val(page, 'Storage (SSD, HDD or NVME)') == '')
    check('the used suggestion row goes away, the others stay', page.locator('#sc-ban .sc-sg[data-sg=RAM]').count() == 0 and page.locator('#sc-ban .sc-sg[data-sg=Color]').count() == 1)
    check('serial is still filled from the photo with its zoom check / double-check', val(page, 'Serial Number') == 'QZXV5BLUQ6L4')
    check('NOTHING was sent to the sheet', not sheet_writes(posts) and not [x for x in posts if x.get('action') == 'scan_photos'], posts)

    # 2. the photo wins over history
    open_scan(page); add(page, PHOTOS[:2]); read(page, TXT_ID_RAM)
    check('photo RAM wins and is not offered again', val(page, 'RAM') == '32GB' and page.locator('#sc-ban [data-sc=hist][data-k=RAM]').count() == 0, val(page, 'RAM'))
    check('photo CPU wins over the past CPU', val(page, 'CPU (and specs)') == 'Apple M9', val(page, 'CPU (and specs)'))
    check('a check explains the disagreement', 'a past purchase of this model has' in page.inner_text('#sc-ban'))

    # 3. no matching history: nothing from history appears
    open_scan(page); add(page, PHOTOS[:2]); read(page, TXT_NONE)
    check('unknown model number: model, CPU, screen stay blank', val(page, 'PC model') == '' and val(page, 'CPU (and specs)') == '' and val(page, 'Screen Size, Hertz') == '')
    check('unknown model number: no suggestions and no "past purchase" wording', page.locator('#sc-ban [data-sc=hist]').count() == 0 and 'past purchase' not in page.inner_text('#sc-ban'))

    # 4. no history at all (empty tab): identical behaviour
    page.evaluate("()=>{(store.base||store.raw).BoughtPCs={sheet:'Form Responses - PCs',rows:[]};}")
    open_scan(page); add(page, PHOTOS[:2]); read(page, TXT_ID)
    check('empty history: nothing filled or suggested from history', val(page, 'PC model') == '' and page.locator('#sc-ban [data-sc=hist]').count() == 0)
    check('still nothing sent to the sheet', not sheet_writes(posts) and not [x for x in posts if x.get('action') == 'scan_photos'], posts)
    check('no page errors', not errors, errors)
    b.close()
print(f'\n{passed} checks passed' + (f', {len(fails)} FAILED: {fails}' if fails else ''))
raise SystemExit(1 if fails else 0)

# Run with: python3 tests/ui-scan-default.py   (needs: pip install playwright pillow and a Chrome/Chromium)
# Drives the real page with a FAKE sheet script and a FAKE text reader. Proves "Read without AI" is the main button:
#  - by default the big button is "Read without AI"; Smart read and AI only are still there, smaller
#  - the main button reads on this device and sends NO scan_photos request; nothing is written to the sheet
#  - one tap on the small switch link brings back the old layout (Smart read first); the choice survives closing and reopening
#  - the AI buttons still work (AI only sends exactly one scan_photos request)
#  - the setting stays on this device: it is never sent to the sheet
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

TXT = "About This Mac\nmacOS Sequoia 15.3\nSerial number QZXV5BLUQ6L4"
def main_label(page): return page.inner_text('#overlay .sc-main').split('\n')[0].strip()

with sync_playwright() as p:
    b, page, errors, posts = run(p)
    open_scan(page); add(page, PHOTOS[:2])
    check('default: the big button is Read without AI', main_label(page) == 'Read without AI', main_label(page))
    check('Smart read and AI only are still there, as secondary buttons', page.locator('.sc-row [data-sc=mix]').count() == 1 and page.locator('.sc-row [data-sc=go]').count() == 1)
    read(page, TXT)
    check('main button read on this device and filled the serial', val(page, 'Serial Number') == 'QZXV5BLUQ6L4')
    check('no scan_photos request and no sheet write', not [x for x in posts if x.get('action') == 'scan_photos'] and not sheet_writes(posts), posts)

    open_scan(page); add(page, PHOTOS[:2])
    page.click('[data-sc=prim]')
    check('one tap switches back: Smart read is the big button again', main_label(page).startswith('Smart read') and page.locator('.sc-row [data-sc=ocr]').count() == 1, main_label(page))
    check('the switch link now offers to go back', 'on this device first' in page.inner_text('[data-sc=prim]'))
    page.evaluate("closeOverlay()")
    open_scan(page); add(page, PHOTOS[:2])
    check('the choice is remembered after closing and reopening', main_label(page).startswith('Smart read'))
    page.click('[data-sc=go]'); page.wait_for_timeout(1500)
    check('the AI button still works: exactly one scan_photos request', len([x for x in posts if x.get('action') == 'scan_photos']) == 1, posts)

    page.evaluate("LS.set('lg.scPrim','')")
    open_scan(page)
    check('clearing the setting restores the default', main_label(page) == 'Read without AI', main_label(page))
    check('the setting is never sent to the sheet', not any('scPrim' in json.dumps(x) for x in posts), posts)
    check('no page errors', not errors, errors)
    b.close()
print(f'\n{passed} checks passed' + (f', {len(fails)} FAILED: {fails}' if fails else ''))
raise SystemExit(1 if fails else 0)

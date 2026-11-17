# Run with: python3 tests/ui-scan-ocr.py [folder-with-jpgs]   (needs: pip install playwright and a Chrome/Chromium)
# Drives the real page with a FAKE sheet script and a FAKE text reader (window.Tesseract is stubbed, so nothing is downloaded). Proves "Read without AI":
#  - the button exists, is off with no photos, and sends NO scan_photos request
#  - a Mac screen fills the Bought PC form from the stubbed OCR text; the serial is "double-check" with a zoomed crop beside it
#  - a script with no Gemini key (error no-key) falls back to the same reader by itself
#  - a Windows wmic serial photo asks "What is it?", then fills the serial; the Windows Device ID goes to Notes, not the serial
#  - nothing is logged to the sheet until Log is pressed; no page errors
import glob, json, pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.example/exec'
PHOTOS = sorted(glob.glob((sys.argv[1] if len(sys.argv) > 1 else '/mnt/user-data/uploads') + '/*.jpg'))[:2]
fails, passed = [], 0
def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

MAC_TXT = "About This Mac\nMacBook Air\nChip Apple M1\nMemory 8 GB\nSerial number HRTJ5BLUQ6L4\nmacOS Sequoia 15.3\nMacintosh HD 214.63 GB available of 245.11 GB\nMaximum Capacity 81%"
WMIC_TXT = "wmic bios get serialnumber\nSerialNumber\nPF2ABCDE\nDevice ID 6F9A1C2E-3B4D-4E5F-8A7B-9C0D1E2F3A4B"
STUB = """window.__ocr={text:'',words:[]};window.Tesseract={createWorker:async()=>({recognize:async()=>({data:{text:window.__ocr.text,confidence:93,words:window.__ocr.words}}),terminate(){}})};"""

def run(p):
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome') if pathlib.Path('/usr/bin/google-chrome').exists() else p.chromium.launch()
    page = b.new_context(viewport={'width': 430, 'height': 900}).new_page()
    errors, posts, reply = [], [], {'scan': {'ok': False, 'error': 'no-key'}}
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    def script(route):
        req = route.request
        h = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}
        if req.method == 'GET': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'service': 'my-money-entry', 'version': 3, 'read': True}), headers=h)
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=h)
        body = json.loads(req.post_data); posts.append(body)
        r = reply['scan'] if body.get('action') == 'scan_photos' else {'ok': True}
        return route.fulfill(status=200, content_type='application/json', body=json.dumps(r), headers=h)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route(URL + '*', script)
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.add_init_script(STUB)
    page.goto(PAGE.as_uri() + '?demo=1')
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}');LS.set('lgSecret','test-key')")
    return b, page, errors, posts, reply

def open_scan(page):
    page.evaluate("document.querySelector('.lg-fab').click()")
    page.wait_for_selector('#overlay [data-sc=fresh]')
    page.click('#overlay [data-sc=fresh]')
    page.wait_for_selector('#sc-st', state='attached')
def add(page, files):
    page.locator('#overlay input[data-sc-file][multiple]').set_input_files(files)
    page.wait_for_function(f"document.querySelectorAll('.sc-t').length>={len(files)}", timeout=60000)
def setocr(page, text, word):
    page.evaluate("([t,w])=>{window.__ocr.text=t;window.__ocr.words=w?[{text:w,confidence:92,bbox:{x0:10,y0:10,x1:220,y1:44}}]:[]}", [text, word])
def val(page, k): return page.input_value(f'#overlay [data-k="{k}"]')

with sync_playwright() as p:
    check('test photos found', len(PHOTOS) >= 2, PHOTOS)
    b, page, errors, posts, reply = run(p)
    open_scan(page)
    check('Read without AI button is there and off with no photos', page.locator('[data-sc=ocr]').count() == 1 and page.locator('[data-sc=ocr]').is_disabled())
    add(page, PHOTOS[:2])
    check('button turns on once photos are added', not page.locator('[data-sc=ocr]').is_disabled())

    # 1. explicit "Read without AI" on a Mac screen
    setocr(page, MAC_TXT, 'HRTJ5BLUQ6L4')
    page.click('[data-sc=ocr]'); page.wait_for_selector('#sc-ban', timeout=30000)
    check('no scan_photos request was sent', not [x for x in posts if x.get('action') == 'scan_photos'])
    check('Bought PC form opened', 'Bought PC' in page.inner_text('#overlay h2'))
    check('serial filled', val(page, 'Serial Number') == 'HRTJ5BLUQ6L4', val(page, 'Serial Number'))
    check('CPU, RAM filled', val(page, 'CPU (and specs)') == 'Apple M1' and val(page, 'RAM') == '8GB', (val(page, 'CPU (and specs)'), val(page, 'RAM')))
    check('storage uses the box size', val(page, 'Storage (SSD, HDD or NVME)') == '256GB (shows 245.11 GB)', val(page, 'Storage (SSD, HDD or NVME)'))
    check('banner says it was read with no AI', 'no AI' in page.inner_text('#sc-ban'))
    check('serial shows a zoomed crop to compare', page.locator('#sc-ban .sc-crop').count() == 1 and page.get_attribute('#sc-ban .sc-crop', 'src').startswith('data:image/jpeg;base64,'))
    check('serial is marked double-check', 'double-check' in page.inner_text('#sc-ban') or page.locator('#sc-ban details').count() == 1)
    check('colour and condition were NOT guessed', val(page, 'Color') == '' and page.locator('#overlay [data-k=Condition][aria-pressed=true]').count() == 0)
    check('battery went to Notes', 'Maximum Capacity 81%' in val(page, 'Notes'), val(page, 'Notes'))
    check('NOTHING was logged to the sheet', not [x for x in posts if x.get('action') not in (None, 'read', 'check', 'settings_get')] , posts)

    # 2. no Gemini key: the normal button falls back by itself
    open_scan(page); add(page, PHOTOS[:2]); setocr(page, MAC_TXT, 'HRTJ5BLUQ6L4')
    reply['scan'] = {'ok': False, 'error': 'no-key'}
    page.click('[data-sc=go]'); page.wait_for_selector('#sc-ban', timeout=30000)
    check('the AI button asked the script once, then read on this device', len([x for x in posts if x.get('action') == 'scan_photos']) == 1 and val(page, 'Serial Number') == 'HRTJ5BLUQ6L4')
    check('no error message was shown for the missing key', 'not switched on' not in page.inner_text('#overlay'))

    # 3. Windows: serial from wmic output is recognised as a PC by itself; Device ID kept out of the serial
    open_scan(page); add(page, PHOTOS[:2]); setocr(page, WMIC_TXT, 'PF2ABCDE')
    page.click('[data-sc=ocr]'); page.wait_for_selector('#sc-ban', timeout=30000)
    check('a Windows wmic screen is recognised as a PC (no "What is it?" question)', page.locator('[data-sc=type]').count() == 0 and 'Bought PC' in page.inner_text('#overlay h2'))
    check('Windows serial filled from wmic output', val(page, 'Serial Number') == 'PF2ABCDE', val(page, 'Serial Number'))
    check('Windows Device ID is in Notes, not the serial', 'Windows Device ID: 6F9A1C2E' in val(page, 'Notes'), val(page, 'Notes'))

    # 4. a bare serial with no clue about the kind of device still asks what it is
    open_scan(page); add(page, PHOTOS[:2]); setocr(page, 'Serial number PF2ABCDE', 'PF2ABCDE')
    page.click('[data-sc=ocr]'); page.wait_for_selector('[data-sc=type]', timeout=30000)
    check('type unclear: it asks what the device is', page.locator('[data-sc=type]').count() == 3)
    page.click('[data-sc=type][data-v=pc]'); page.wait_for_selector('#sc-ban', timeout=30000)
    check('serial filled after choosing the type', val(page, 'Serial Number') == 'PF2ABCDE', val(page, 'Serial Number'))

    check('no page errors', not errors, errors)
    b.close()
print(f'\n{passed} checks passed' + (f', {len(fails)} FAILED: {fails}' if fails else ''))
sys.exit(1 if fails else 0)

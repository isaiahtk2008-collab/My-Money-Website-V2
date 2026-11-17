# Run with: python3 tests/ui-scan-mix.py [folder-with-jpgs]   (needs: pip install playwright and a Chrome/Chromium)
# Drives the real page with a FAKE sheet script and a FAKE text reader. Proves the Scan photos screen's three ways to read and its layout:
#  - "Smart read" (AI + on-device together), "AI only" and "Read without AI" all exist, are off with no photos, and are evenly spaced (no overlap, no overflow, 10px gaps)
#  - Smart read sends ONE scan request and combines the two readings: agreed fields are solid, a serial that the two disagree on is left blank and says why
#  - if the AI fails (no key, quota, offline, not connected) the on-device reading still fills the form and the banner says so; if the on-device reader fails the AI reading is used
#  - a photo taken sideways is turned until it reads; a photo with plenty of text is not rotated or re-read
#  - nothing is logged until Log is pressed; no page errors
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



AI_MAC = {'ok': True, 'result': {'deviceType': 'pc', 'accessoryType': None, 'conflicts': [], 'notes': [{'kind': 'battery', 'text': 'Maximum Capacity 81%', 'image': 1}],
  'fields': {'serial': {'value': 'HRTJ5BLUQ6L4', 'confidence': 'high', 'evidence': 'serial', 'image': 1},
             'model': {'value': 'MacBook Air M1', 'confidence': 'high', 'evidence': 'title', 'image': 1},
             'color': {'value': 'Space Gray', 'confidence': 'high', 'evidence': 'photo', 'image': 2},
             'cpu': {'value': 'Apple M1', 'confidence': 'high', 'evidence': 'chip', 'image': 1},
             'ram': {'value': '8 GB', 'confidence': 'high', 'evidence': 'memory', 'image': 1}}}}
def ai_with(**over):
    import copy; r = copy.deepcopy(AI_MAC)
    for k, v in over.items(): r['result']['fields'][k] = v
    return r
def scans(posts): return [x for x in posts if x.get('action') == 'scan_photos']
def rect(page, sel): return page.evaluate("(s)=>{const r=document.querySelector(s).getBoundingClientRect();return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:r.width,h:r.height}}", sel)
def fresh(page, files):
    open_scan(page); add(page, files)
def row_text(page, label): return page.evaluate("(l)=>{const li=[...document.querySelectorAll('#sc-ban li')].find(x=>x.textContent.trim().startsWith(l));return li?li.textContent:''}", label)

with sync_playwright() as p:
    check('test photos found', len(PHOTOS) >= 2, PHOTOS)
    b, page, errors, posts, reply = run(p)
    SHOTS = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None

    # ---- 1. buttons and layout
    open_scan(page)
    check('three read buttons exist', all(page.locator(f'[data-sc={k}]').count() == 1 for k in ('mix', 'go', 'ocr')))
    check('all three are off with no photos', all(page.locator(f'[data-sc={k}]').is_disabled() for k in ('mix', 'go', 'ocr')))
    add(page, PHOTOS[:2])
    check('all three turn on with photos', not any(page.locator(f'[data-sc={k}]').is_disabled() for k in ('mix', 'go', 'ocr')))
    def layout(tag):
        tk = page.locator('#overlay label.sc-pick').all() if page.locator('#overlay label.sc-pick').count() else page.locator('#overlay .sc-pick').all()
        a, c = rect(page, '[data-sc=mix]'), None
        g, o = rect(page, '[data-sc=go]'), rect(page, '[data-sc=ocr]')
        picks = page.evaluate("()=>[...document.querySelectorAll('#overlay .sc-pick')].map(e=>{const r=e.getBoundingClientRect();return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:r.width,h:r.height}})")
        vw = page.evaluate('innerWidth')
        check(tag + ': Take photo and Choose photos are side by side, equal size, 10px apart', len(picks) == 2 and abs(picks[0]['w'] - picks[1]['w']) < 1.5 and abs((picks[1]['l'] - picks[0]['r']) - 10) < 1.5 and abs(picks[0]['t'] - picks[1]['t']) < 1.5, picks)
        check(tag + ': AI only and Read without AI are side by side, equal size, 10px apart', abs(g['w'] - o['w']) < 1.5 and abs((o['l'] - g['r']) - 10) < 1.5 and abs(g['t'] - o['t']) < 1.5 and abs(g['h'] - o['h']) < 1.5, (g, o))
        check(tag + ': Smart read sits above them with a 10px gap and spans both', abs((g['t'] - a['b']) - 10) < 1.5 and abs(a['l'] - g['l']) < 1.5 and abs(a['r'] - o['r']) < 1.5, (a, g, o))
        check(tag + ': nothing overflows the screen sideways', all(x['l'] >= 0 and x['r'] <= vw for x in (a, g, o) + tuple(picks)) and page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), (vw, a, g, o))
        check(tag + ': buttons are finger-sized (44px+), Smart read is the biggest', min(a['h'], g['h'], o['h'], *[x['h'] for x in picks]) >= 43 and a['h'] > g['h'], (a['h'], g['h'], o['h'], [x['h'] for x in picks]))
    layout('430px wide')
    if SHOTS: SHOTS.mkdir(parents=True, exist_ok=True); page.screenshot(path=str(SHOTS / 'scan-430.png'))
    page.set_viewport_size({'width': 360, 'height': 740}); page.wait_for_timeout(200)
    layout('360px wide')
    if SHOTS: page.screenshot(path=str(SHOTS / 'scan-360.png'))
    page.set_viewport_size({'width': 430, 'height': 900}); page.wait_for_timeout(200)

    # ---- 2. Smart read, AI and on-device agree
    setocr(page, MAC_TXT, 'HRTJ5BLUQ6L4'); reply['scan'] = AI_MAC
    page.click('[data-sc=mix]'); page.wait_for_selector('#sc-ban', timeout=30000)
    check('Smart read sent exactly ONE scan request', len(scans(posts)) == 1, len(scans(posts)))
    check('Bought PC form opened', 'Bought PC' in page.inner_text('#overlay h2'))
    check('banner says Smart read combined both', 'Smart read' in page.inner_text('#sc-ban'))
    check('colour came from the AI (the on-device reader cannot see it)', val(page, 'Color') == 'Space Gray', val(page, 'Color'))
    check('serial filled', val(page, 'Serial Number') == 'HRTJ5BLUQ6L4', val(page, 'Serial Number'))
    check('storage came from the on-device reading (the AI did not give it)', val(page, 'Storage (SSD, HDD or NVME)') == '256GB (shows 245.11 GB)', val(page, 'Storage (SSD, HDD or NVME)'))
    check('RAM was seen by BOTH, so it is solid (not "double-check")', val(page, 'RAM') == '8GB' and 'double-check' not in row_text(page, 'RAM'), row_text(page, 'RAM'))
    check('the serial still shows its zoomed crop to compare', page.locator('#sc-ban img').count() >= 1)
    check('battery note from either reading is in Notes', 'Maximum Capacity 81%' in val(page, 'Notes'), val(page, 'Notes'))
    check('battery note is there once, not twice', val(page, 'Notes').count('Maximum Capacity 81%') == 1, val(page, 'Notes'))
    if SHOTS: page.screenshot(path=str(SHOTS / 'smart-result.png'))
    check('NOTHING was logged to the sheet', not [x for x in posts if x.get('action') not in (None, 'scan_photos', 'read')], [x.get('action') for x in posts])

    # ---- 3. serial: the two readings disagree
    fresh(page, PHOTOS[:2]); setocr(page, MAC_TXT, 'HRTJ5BLUQ6L4'); reply['scan'] = ai_with(serial={'value': 'HRTJ5BLUQ6L5', 'confidence': 'high', 'evidence': 'serial', 'image': 1})
    page.click('[data-sc=mix]'); page.wait_for_selector('#sc-ban', timeout=30000)
    check('serial left BLANK when AI and on-device disagree', val(page, 'Serial Number') == '', val(page, 'Serial Number'))
    check('the banner shows both readings', 'HRTJ5BLUQ6L5' in page.inner_text('#sc-ban') and 'HRTJ5BLUQ6L4' in page.inner_text('#sc-ban'), page.inner_text('#sc-ban')[:400])

    # ---- 4. specs disagree: on-device text wins, flagged
    fresh(page, PHOTOS[:2]); setocr(page, MAC_TXT, 'HRTJ5BLUQ6L4'); reply['scan'] = ai_with(ram={'value': '16 GB', 'confidence': 'high', 'evidence': 'memory', 'image': 1})
    page.click('[data-sc=mix]'); page.wait_for_selector('#sc-ban', timeout=30000)
    check('RAM disagreement: the text copied from the screen is used', val(page, 'RAM') == '8GB', val(page, 'RAM'))
    check('RAM disagreement is flagged double-check and explained', 'double-check' in row_text(page, 'RAM') and 'RAM' in page.inner_text('#sc-ban') and '16 GB' in page.inner_text('#sc-ban'))

    # ---- 5. the AI fails: the on-device reading still fills the form, and it says why
    for err, why in [('no-key', 'No Gemini key'), ('quota', 'could not be used'), ('busy', 'could not be used')]:
        fresh(page, PHOTOS[:2]); setocr(page, MAC_TXT, 'HRTJ5BLUQ6L4'); reply['scan'] = {'ok': False, 'error': err}
        page.click('[data-sc=mix]'); page.wait_for_selector('#sc-ban', timeout=30000)
        check(f'AI error {err}: form still filled from the on-device reading', val(page, 'Serial Number') == 'HRTJ5BLUQ6L4' and val(page, 'RAM') == '8GB')
        check(f'AI error {err}: banner says what happened', why.lower() in page.inner_text('#sc-ban').lower() and 'on this device only' in page.inner_text('#sc-ban'), page.inner_text('#sc-ban')[:300])
        check(f'AI error {err}: colour is NOT guessed', val(page, 'Color') == '')
    # not connected to a sheet: no request at all
    fresh(page, PHOTOS[:2]); setocr(page, MAC_TXT, 'HRTJ5BLUQ6L4')
    n0 = len(scans(posts)); page.evaluate("LS.set('lgUrl','')"); reply['scan'] = AI_MAC
    page.click('[data-sc=mix]'); page.wait_for_selector('#sc-ban', timeout=30000)
    check('no sheet connected: no AI request, on-device reading still works', len(scans(posts)) == n0 and val(page, 'Serial Number') == 'HRTJ5BLUQ6L4')
    page.evaluate(f"LS.set('lgUrl','{URL}')")

    # ---- 6. the on-device reader fails: the AI reading is used
    fresh(page, PHOTOS[:2]); reply['scan'] = AI_MAC
    page.evaluate("window.__realCW=window.Tesseract.createWorker;window.Tesseract.createWorker=async()=>{throw new Error('no reader')};0")
    page.click('[data-sc=mix]'); page.wait_for_selector('#sc-ban', timeout=30000)
    check('reader failed: the AI reading fills the form', val(page, 'Serial Number') == 'HRTJ5BLUQ6L4' and val(page, 'Color') == 'Space Gray')
    check('reader failed: banner says it is the AI reading only', 'AI reading only' in page.inner_text('#sc-ban'), page.inner_text('#sc-ban')[:300])
    # ---- 7. both fail: a plain message, no form
    fresh(page, PHOTOS[:2]); reply['scan'] = {'ok': False, 'error': 'quota'}
    page.click('[data-sc=mix]'); page.wait_for_function("document.querySelector('#sc-st').textContent.length>0")
    check('both failed: a message is shown and no form opened', 'Could not read' in page.inner_text('#sc-st') or 'quota' in page.inner_text('#sc-st').lower(), page.inner_text('#sc-st'))
    page.evaluate("window.Tesseract.createWorker=window.__realCW;0")

    # ---- 8. one tap while busy cannot start a second read
    fresh(page, PHOTOS[:2]); setocr(page, MAC_TXT, 'HRTJ5BLUQ6L4'); reply['scan'] = AI_MAC; n1 = len(scans(posts))
    page.evaluate("document.querySelector('[data-sc=mix]').click();document.querySelector('[data-sc=mix]')&&document.querySelector('[data-sc=mix]').click()")
    page.wait_for_selector('#sc-ban', timeout=30000)
    check('a double tap sends only one request', len(scans(posts)) - n1 == 1, len(scans(posts)) - n1)

    # ---- 9. sideways photo: turned until it reads; a normal photo is read once
    rot = pathlib.Path(PHOTOS[0]).parent / 'portrait'; rot.mkdir(exist_ok=True)
    from PIL import Image
    Image.open(PHOTOS[0]).rotate(90, expand=True).save(rot / 'sideways.jpg')
    page.evaluate("""window.__calls=[];window.__words=Array.from({length:14},(_,i)=>({text:'Word'+i+'abc',confidence:92,bbox:{x0:1,y0:1,x1:9,y1:9}}));
      window.Tesseract.createWorker=async()=>({recognize:async(cv)=>{window.__calls.push(cv.width+'x'+cv.height);
        const ok=cv.width>cv.height;return {data:{text:ok?window.__ocr.text:'',confidence:90,words:ok?window.__words:[]}}},terminate(){}});0""")
    open_scan(page); add(page, [str(rot / 'sideways.jpg')]); setocr(page, MAC_TXT, 'HRTJ5BLUQ6L4'); reply['scan'] = {'ok': False, 'error': 'no-key'}
    page.click('[data-sc=ocr]'); page.wait_for_selector('#sc-ban', timeout=30000)
    calls = page.evaluate('window.__calls')
    check('sideways photo: it was turned and read', val(page, 'Serial Number') == 'HRTJ5BLUQ6L4', calls)
    check('sideways photo: 1 read + 2 small probes + 1 full read', len(calls) == 4, calls)
    check('sideways photo: the probes were small copies', all(int(c.split('x')[0]) <= 1100 and int(c.split('x')[1]) <= 1100 for c in calls[1:3]), calls)
    page.evaluate('window.__calls=[]')
    open_scan(page); add(page, PHOTOS[:1]); setocr(page, MAC_TXT, 'HRTJ5BLUQ6L4')
    page.click('[data-sc=ocr]'); page.wait_for_selector('#sc-ban', timeout=30000)
    check('a normal photo with plenty of text is read once, not rotated', len(page.evaluate('window.__calls')) == 1, page.evaluate('window.__calls'))
    check('no page errors', not errors, errors[:3])
    b.close()

print(f'\n{passed} checks passed' + (f', {len(fails)} FAILED: {fails}' if fails else ''))
sys.exit(1 if fails else 0)

# Run with: python3 tests/ui-scan-photos.py [folder-with-jpgs]   (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake sheet script (never touches Google or Gemini). Proves the Scan photos feature:
#  - several photos can be added and are shrunk before sending; one scan_photos request carries them all
#  - the right form opens and is pre-filled with exactly what was read, with extra details in Notes
#  - NOTHING is sent to the sheet until the Log button is pressed, and the Log request is the normal one for that tab
#  - unclear or invalid readings are left blank (low-confidence serial, IMEI failing its check digit, unknown option values)
#  - selling mode only picks a device on an exact serial match; unknown type asks; every error shows a plain message
import glob, json, pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.example/exec'
PHOTOS = sorted(glob.glob((sys.argv[1] if len(sys.argv) > 1 else '/mnt/user-data/uploads') + '/*.jpg'))[:10]
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

def F(v, conf='high', ev='', img=1, **kw):
    d = {'value': v, 'confidence': conf, 'evidence': ev, 'image': img}; d.update(kw); return d

MAC = {'deviceType': 'pc', 'accessoryType': None, 'fields': {
    'model': F('MacBook Air', ev='MacBook Air'), 'color': F('Space Gray', 'medium', 'grey aluminium', 2),
    'serial': F('HRTJ5BLUQ6L4', ev='Serial number HRTJ5BLUQ6L4', img=1), 'imei': None,
    'cpu': F('Apple M1', ev='Chip Apple M1'), 'gpu1': None, 'gpu2': None, 'ram': F('8 GB', ev='Memory 8 GB'),
    'storage': F('245.11 GB', ev='214.63 GB available of 245.11 GB', totalGB=245.11), 'screen': F('13.3-inch (2560 x 1600)', ev='Built-in Retina Display'),
    'os': F('macOS Sequoia 15.3', ev='Version 15.3'), 'chargerIncluded': F(True, 'medium', 'Apple USB-C charger', 3),
    'boxIncluded': None, 'caseIncluded': None, 'connection': None},
  'notes': [{'kind': 'battery', 'text': 'Maximum capacity 81%, condition Normal', 'image': 7},
            {'kind': 'software', 'text': 'macOS Sequoia 15.3, not signed in to an Apple Account', 'image': 1},
            {'kind': 'storage', 'text': '214.63 GB available of 245.11 GB', 'image': 1},
            {'kind': 'cosmetic', 'text': 'Clear film on the left palm rest, no cracks visible', 'image': 4}],
  'conflicts': []}

def run(p):
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 430, 'height': 900}).new_page()
    errors, posts, reply = [], [], {}
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

def scan(page, res, files):
    scan_reply = {'ok': True, 'result': res}
    return scan_reply

def val(page, k): return page.input_value(f'#overlay [data-k="{k}"]')

with sync_playwright() as p:
    check('test photos found', len(PHOTOS) >= 3, PHOTOS)
    b, page, errors, posts, reply = run(p)

    # ---- 1. the menu has the entry, the screen starts empty and the button is off
    page.evaluate("document.querySelector('.lg-fab').click()")
    page.wait_for_selector('#overlay [data-sc=fresh]')
    check('Log menu shows a Scan photos button', 'Scan photos' in page.inner_text('#overlay [data-sc=fresh]'))
    check('the forms menu still lists all six buy/sell forms', page.locator('#overlay [data-lg=open]').count() >= 9)
    page.click('#overlay [data-sc=fresh]'); page.wait_for_selector('#sc-st', state='attached')
    check('Read photos is disabled with no photos', page.locator('[data-sc=go]').is_disabled())

    # ---- 2. multiple real photos, big phone pictures get shrunk
    add(page, PHOTOS)
    check('every photo was added', page.locator('.sc-t').count() == len(PHOTOS), page.locator('.sc-t').count())
    check('adding the same files again adds nothing', (page.locator('#overlay input[data-sc-file][multiple]').set_input_files(PHOTOS) or True) and (page.wait_for_timeout(1500) or True) and page.locator('.sc-t').count() == len(PHOTOS))
    page.click('.sc-x >> nth=0'); check('a photo can be removed', page.locator('.sc-t').count() == len(PHOTOS) - 1)
    add(page, PHOTOS[:1]); page.wait_for_function(f"document.querySelectorAll('.sc-t').length=={len(PHOTOS)}", timeout=30000)

    # ---- 3. read: one request, the right form, exact values, nothing logged
    reply['scan'] = {'ok': True, 'result': MAC}
    page.click('[data-sc=go]')
    page.wait_for_selector('#sc-ban', timeout=30000)
    scans = [x for x in posts if x.get('action') == 'scan_photos']
    check('exactly one scan_photos request carrying every photo', len(scans) == 1 and len(scans[0]['images']) == len(PHOTOS) and scans[0]['secret'] == 'test-key' and scans[0]['mode'] == 'buy')
    sizes = [len(i['data']) for i in scans[0]['images']]
    check('each photo was shrunk below the script limit', all(x < 5.5e6 for x in sizes) and sum(sizes) < 15.5e6, sizes)
    check('the request is JPEG data only', all(i['mime'] == 'image/jpeg' and not i['data'].startswith('data:') for i in scans[0]['images']))
    check('the Bought PC form opened', 'Bought PC' in page.inner_text('#overlay h2'))
    exp = {'Serial Number': 'HRTJ5BLUQ6L4', 'PC model': 'MacBook Air', 'Color': 'Space Gray', 'CPU (and specs)': 'Apple M1', 'RAM': '8GB',
           'Storage (SSD, HDD or NVME)': '256GB (shows 245.11 GB)', 'Screen Size, Hertz': '13.3-inch (2560 x 1600)'}
    for k, v in exp.items(): check('filled ' + k + ' = ' + v, val(page, k) == v, val(page, k))
    check('GPU 1 left blank (not visible)', val(page, 'GPU 1 (and specs)') == '')
    check('Original Charger set to Yes', page.get_attribute('#overlay [data-lg=pick][data-k="Original Charger"][data-v=Yes]', 'aria-pressed') == 'true')
    check('Condition NOT guessed', page.locator('#overlay [data-k=Condition][aria-pressed=true]').count() == 0)
    check('price and seller NOT guessed', val(page, 'Purchase Price') == '' and val(page, 'Bought From') == '')
    notes = val(page, 'Notes')
    check('battery health went to Notes', 'Maximum capacity 81%' in notes, notes)
    check('OS and cosmetic details went to Notes', 'macOS Sequoia 15.3' in notes and 'palm rest' in notes)
    check('nothing was sent to the sheet yet', all(x.get('action') == 'scan_photos' for x in posts), [x.get('action') or x.get('tab') for x in posts])
    check('banner says nothing is logged and shows photos', 'Nothing is logged yet' in page.inner_text('#sc-ban') and page.locator('#sc-ban .sc-th img').count() == len(PHOTOS))
    check('banner reminds to compare the serial', 'serial' in page.inner_text('#sc-ban').lower())
    check('filled fields are highlighted until edited', page.locator('.lg-f.sc-ai').count() >= 7)
    page.fill('#overlay [data-k="Color"]', 'Silver'); check('editing a field removes its highlight and keeps the edit', page.locator('.lg-f.sc-ai[data-f=Color]').count() == 0 and val(page, 'Color') == 'Silver')
    page.fill('#overlay [data-k="Color"]', 'Space Gray')

    # ---- 4. the user finishes and presses Log: ONE normal request for the right tab
    page.fill('#overlay [data-k="GPU 1 (and specs)"]', 'Apple M1 integrated')
    page.click('#overlay [data-lg=pick][data-k=Condition][data-v="Used - Good"]')
    page.fill('#overlay [data-k="Purchase Price"]', '500'); page.fill('#overlay [data-k="Bought From"]', 'Test Seller')
    page.click('#overlay [data-lg=submit]'); page.wait_for_selector('#overlay .lg-done')
    logs = [x for x in posts if x.get('action') != 'scan_photos']
    check('pressing Log sent exactly one entry', len(logs) == 1, logs)
    L = logs[0]
    check('it targets the PCs tab with the read values', L['tab'] == 'Form Responses - PCs' and L['values']['Serial Number'] == 'HRTJ5BLUQ6L4' and L['values']['RAM'] == '8GB' and L['values']['Purchase Price'] == 500 and 'Maximum capacity 81%' in L['values']['Notes'], L)

    # ---- 5. accuracy guards
    def rescan(res, mode='buy'):
        page.evaluate("document.querySelector('.lg-fab').click()")
        page.wait_for_selector('#overlay [data-sc=fresh]'); page.click('#overlay [data-sc=fresh]'); page.wait_for_selector('#sc-st', state='attached')
        if mode == 'sell': page.click('[data-sc=mode][data-v=sell]')
        add(page, PHOTOS[:1]); reply['scan'] = {'ok': True, 'result': res}; page.click('[data-sc=go]')
    bad = json.loads(json.dumps(MAC)); bad['fields']['serial'] = F('HRTJ5BLUQ6L4', 'low', 'blurry'); bad['fields']['cpu'] = F('Apple M1', 'low', 'blurry')
    rescan(bad); page.wait_for_selector('#sc-ban')
    check('a low-confidence serial is NOT filled and is listed for checking', val(page, 'Serial Number') == '' and 'serial number' in page.inner_text('#sc-ban').lower())
    check('a low-confidence spec is NOT filled', val(page, 'CPU (and specs)') == '')
    page.click('#overlay [data-lg=discard]') if page.locator('#overlay [data-lg=discard]').count() else None

    ph = {'deviceType': 'phone', 'accessoryType': None, 'fields': {'model': F('Galaxy S23 Ultra'), 'color': F('Black'), 'serial': F('R5CW123ABCD'), 'imei': F('356938035643809'),
          'storage': F('256 GB', totalGB=256), 'chargerIncluded': F(True), 'boxIncluded': F(True), 'caseIncluded': None}, 'notes': [{'kind': 'battery', 'text': 'Health 96%'}], 'conflicts': []}
    rescan(ph); page.wait_for_selector('#sc-ban')
    check('a phone opens the Bought phone form with a valid IMEI as its serial', 'Bought phone' in page.inner_text('#overlay h2') and val(page, 'Serial Number') == '356938035643809' and val(page, 'Storage (GB)') == '256')
    check('the phone serial goes to Notes and box/charger are Yes', 'Serial: R5CW123ABCD' in val(page, 'Notes') and page.get_attribute('#overlay [data-lg=pick][data-k="Original Box"][data-v=Yes]', 'aria-pressed') == 'true')
    ph['fields']['imei'] = F('356938035643808')   # fails the check digit
    rescan(ph); page.wait_for_selector('#sc-ban')
    check('an IMEI that fails its check digit is NOT used', val(page, 'Serial Number') == 'R5CW123ABCD' and 'IMEI' in page.inner_text('#sc-ban'))

    amb = json.loads(json.dumps(MAC)); amb['deviceType'] = 'unknown'
    rescan(amb); page.wait_for_selector('[data-sc=type]')
    check('an unclear device type asks which form', page.locator('[data-sc=type]').count() == 3)
    page.click('[data-sc=type][data-v=pc]'); page.wait_for_selector('#sc-ban')
    check('choosing the type fills that form from the same reading', 'Bought PC' in page.inner_text('#overlay h2') and val(page, 'Serial Number') == 'HRTJ5BLUQ6L4')

    # ---- 6. selling: only an exact serial match picks a device
    page.evaluate("""(()=>{const it=store.D.items.find(i=>i.kind==='PC'&&!i.sold);window.__it=it;it.serial='HRTJ5BLUQ6L4'})()""")
    rescan(MAC, 'sell'); page.wait_for_selector('#sc-ban')
    lab = page.evaluate("__it.label||__it.name")
    check('selling mode opens Sold PC and picks the one device with that serial', 'Sold PC' in page.inner_text('#overlay h2') and page.input_value('#overlay select[data-k=Device]') == lab)
    check('selling mode fills nothing else (price, buyer stay yours)', val(page, 'Sale Price') == '' and val(page, 'Sold to') == '')
    page.evaluate("__it.serial='ZZZZZZZZZZZZ'")
    rescan(MAC, 'sell'); page.wait_for_selector('#sc-ban')
    check('no serial match = no device picked, and it says so', page.input_value('#overlay select[data-k=Device]') == '' and 'No unsold device' in page.inner_text('#sc-ban'))

    # ---- 7. every failure shows a plain message and writes nothing
    for err, text in [('no-key', 'GEMINI_API_KEY'), ('quota', 'quota'), ('bad-key', 'rejected'), ('tab not allowed: undefined', 'update'), ('busy', 'busy')]:
        page.evaluate("document.querySelector('.lg-fab').click()"); page.wait_for_selector('#overlay [data-sc=fresh]'); page.click('#overlay [data-sc=fresh]'); page.wait_for_selector('#sc-st', state='attached')
        add(page, PHOTOS[:1]); reply['scan'] = {'ok': False, 'error': err}; page.click('[data-sc=go]')
        page.wait_for_function("document.querySelector('#sc-st').textContent.length>0")
        check('error ' + err + ' shows a message', text.lower() in page.inner_text('#sc-st').lower(), page.inner_text('#sc-st'))
    page.evaluate("document.querySelector('.lg-fab').click()"); page.wait_for_selector('#overlay [data-sc=fresh]'); page.click('#overlay [data-sc=fresh]'); page.wait_for_selector('#sc-st', state='attached')
    add(page, PHOTOS[:1]); reply['scan'] = {'ok': True, 'result': {'deviceType': 'unknown', 'fields': {'model': None}, 'notes': [], 'conflicts': []}}; page.click('[data-sc=go]')
    page.wait_for_function("document.querySelector('#sc-st').textContent.length>0")
    check('an empty reading says nothing was found and opens no form', 'Nothing readable' in page.inner_text('#sc-st') and page.locator('#sc-ban').count() == 0)
    acts = sorted({str(x.get('action')) for x in posts})
    check('only the Log press ever wrote to the sheet (other requests are scans and plain reads)', set(acts) <= {'scan_photos', 'read', 'check', 'settings_get', 'None'} and len([x for x in posts if x.get('tab')]) == 1, acts)
    check('no page errors', not errors, errors)
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
if fails: sys.exit(1)

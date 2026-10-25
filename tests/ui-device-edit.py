# Run with: python3 tests/ui-device-edit.py   (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script and a fake phone + purchase row. Proves the device drawer footer
# (Delete disabled, Edit enabled), the Edit purchase popup, the one-row edit request, validation, errors and the unmatched case. Never touches Google.
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
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)   # Tailwind CDN is blocked in the test
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)

    def script(route):
        req = route.request
        if req.method == 'GET':
            body = {'ok': True, 'service': 'my-money-entry', 'version': 3, 'read': True}
            if mode_holder['edit']: body['edit'] = True
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(body), headers={'access-control-allow-origin': '*'})
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*'})
        posts.append(json.loads(req.post_data))
        return route.fulfill(status=200, content_type='application/json', body=json.dumps(mode_holder['reply']), headers={'access-control-allow-origin': '*'})
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())   # block everything else (CDNs, Google)
    page.route(URL + '*', script)                                                                       # last registered wins
    # Simulate a signed-in session (the page's own flag), so the sign-in screen does not cover the app.
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri())
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}')")
    return b, page, errors, posts


import os, tempfile

PURCHASE_ROW = {
    'Timestamp': '2026-10-01T10:00:00', 'Row ID': 'ab12', 'Serial Number': '356789012345678', 'Phone Model': 'iPhone 13',
    'Color': 'Blue', 'Storage (GB)': 128, 'Condition': 'Used - Good', 'Screen Condition': 'Light scratches',
    'Original Box': 'No', 'Charger': 'Yes', 'Case': 'No', 'Purchased Price': 450, 'Purchase Date': '2026-09-30',
    'Bought From': 'Sam', 'Phone Number / Email Address': None, 'Meetup Location / Address': 'Square One', 'Notes': None
}
ALL_POSTS = []

def load_phone(page, purchase_serial='356789012345678'):
    return page.evaluate("""([pRow, serial]) => {
        let raw = JSON.parse(JSON.stringify(store.raw));
        raw.Phones = {sheet: 'Master Inventory',
            headers: ['Model','IMEI','Status','Purchase Price','Purchase Date','Bought From','Color','Condition'],
            rows: [{'Model': 'iPhone 13','IMEI': '356789012345678','Status': 'IN INVENTORY','Purchase Price': 450,
                    'Purchase Date': '2026-09-30','Bought From': 'Sam','Color': 'Blue','Condition': 'Used - Good'}]};
        raw.BoughtPhones = {sheet: 'Form Responses - Bought', headers: Object.keys(pRow),
            rows: [Object.assign({}, pRow, {'Serial Number': serial}),
                   Object.assign({}, pRow, {'Row ID': 'cd34', 'Serial Number': '999999999999999'})]};
        store.set(raw);
        const item = store.D.items.find(x => x.kind === 'Phone');
        return item ? item.id : null;
    }""", [PURCHASE_ROW, purchase_serial])

def open_drawer(page, pid):
    page.evaluate("pid => openDetail(pid)", pid)
    page.wait_for_selector('.dfoot', state='attached')


def scenarios_a(p):
    mode = {'edit': True, 'reply': {'ok': True}}
    b, page, errors, posts = run(mode, p)
    pid = load_phone(page)
    open_drawer(page, pid)

    # (1) footer: button states, layout, note, styles
    del_btn = page.locator('.dfoot button.btn.danger')
    edit_btn = page.locator('[data-act=devedit]')
    check('Delete exists once and is disabled', del_btn.count() == 1 and del_btn.is_disabled())
    check('Edit exists once and is enabled', edit_btn.count() == 1 and edit_btn.is_enabled())
    del_box, edit_box = del_btn.bounding_box(), edit_btn.bounding_box()
    check('Delete is bottom-left and Edit is bottom-right', del_box['x'] < edit_box['x'] and abs(del_box['y'] - edit_box['y']) < 4, f'{del_box} {edit_box}')
    check('the Delete note is shown', 'Delete purchases and sales directly in Google Sheets for now' in (page.locator('#overlay').text_content() or ''))
    edit_classes = (edit_btn.get_attribute('class') or '').split()
    check('Edit uses the primary style', 'sec' not in edit_classes and 'danger' not in edit_classes)
    page.screenshot(path=os.path.join(tempfile.gettempdir(), 'device-drawer.png'))

    # (2) the disabled Delete sends nothing
    try:
        del_btn.click(force=True, timeout=2000)
    except Exception:
        pass
    check('clicking the disabled Delete sends nothing', len(posts) == 0)

    # (3) Edit popup: one tab, same fields as the logging form, pre-filled from the Bought row
    edit_btn.click()
    deform = page.locator('[data-deform]')
    check('Edit opens the popup', deform.is_visible())
    check('popup has the Edit purchase tab', 'Edit purchase' in (deform.text_content() or ''))
    check('popup has the same number of fields as the logging form', page.locator('[data-df]').count() == page.evaluate("MMLog.BY.bphone.f.length"))
    keys = page.evaluate("MMLog.BY.bphone.f.map(x=>x.k)")
    check('popup fields come from the logging form keys', 'Purchased Price' in keys and 'Bought From' in keys)
    check('price is pre-filled', page.locator('[data-dk="Purchased Price"]').input_value() == '450.00')
    check('seller is pre-filled', page.locator('[data-dk="Bought From"]').input_value() == 'Sam')

    # (4) saving without touching anything sends nothing
    page.locator('[data-deform] button[type=submit]').click()
    check('saving with no changes sends nothing and keeps the popup', len(posts) == 0 and deform.is_visible())
    check('no page errors (scenario a)', not errors, str(errors[:3]))
    ALL_POSTS.extend(posts)
    b.close()


def scenarios_b(p):
    def open_edit(page):
        page.click('[data-act=devedit]')
        page.wait_for_selector('[data-deform]', state='visible')

    def session(reply, serial='356789012345678'):
        b, page, errors, posts = run({'edit': True, 'reply': reply}, p)
        pid = load_phone(page, purchase_serial=serial)
        open_drawer(page, pid)
        return b, page, errors, posts

    # (5) a successful one-field edit
    b, page, errors, posts = session({'ok': True, 'updated': ['Bought From']})
    try:
        open_edit(page)
        page.screenshot(path=os.path.join(tempfile.gettempdir(), 'device-edit-popup.png'))
        page.fill('[data-dk="Bought From"]', 'Alex')
        page.click('[data-deform] button[type=submit]')
        page.wait_for_selector('[data-deform]', state='detached', timeout=5000)
        check('one edit request was sent', len(posts) == 1, str(posts))
        p0 = posts[0] if posts else {}
        check('request is an edit of the Bought tab and that one Row ID', p0.get('action') == 'edit' and p0.get('target') == 'Form Responses - Bought' and p0.get('rowId') == 'ab12', str(p0))
        check('only the changed field is sent', p0.get('changes') == {'Bought From': 'Alex'}, str(p0))
        check('expect holds 2+ unchanged columns', len(p0.get('expect', {})) >= 2 and 'Bought From' not in p0.get('expect', {}), str(p0))
        check('request has no old-style row number', 'row' not in p0)
        check('loaded data updated for that row only', page.evaluate("store.raw.BoughtPhones.rows.map(r=>r['Bought From'])") == ['Alex', 'Sam'])
    finally:
        check('no page errors (scenario 5)', not errors, str(errors[:3]))
        ALL_POSTS.extend(posts)
        b.close()

    # (6) money validation
    b, page, errors, posts = session({'ok': True})
    try:
        open_edit(page)
        for bad in ('abc', '-5'):
            page.fill('[data-dk="Purchased Price"]', bad)
            page.click('[data-deform] button[type=submit]')
            err = page.locator('[data-df="Purchased Price"] [data-derr]')
            check(f'"{bad}" is rejected with a message and nothing is sent', len(posts) == 0 and err.is_visible() and bool((err.text_content() or '').strip()))
    finally:
        check('no page errors (scenario 6)', not errors, str(errors[:3]))
        ALL_POSTS.extend(posts)
        b.close()

    # (7) the script refuses: readable error, popup stays, data unchanged
    b, page, errors, posts = session({'ok': False, 'error': 'no_match'})
    try:
        open_edit(page)
        page.fill('[data-dk="Bought From"]', 'Zed')
        page.click('[data-deform] button[type=submit]')
        page.wait_for_timeout(1500)
        msg = page.locator('#ed-msg')
        check('on failure the popup stays open', page.locator('[data-deform]').count() == 1)
        check('on failure a readable error is shown', msg.is_visible() and bool((msg.text_content() or '').strip()), msg.text_content() or '')
        check('on failure the loaded data is unchanged', page.evaluate("store.raw.BoughtPhones.rows[0]['Bought From']") == 'Sam')
    finally:
        check('no page errors (scenario 7)', not errors, str(errors[:3]))
        ALL_POSTS.extend(posts)
        b.close()

    # (9) no safe match: message, no buttons
    b, page, errors, posts = session({'ok': True}, serial='000000000000000')
    try:
        check('unmatched item shows the safety message', "Can't safely match this item to its sheet row" in (page.text_content('.dfoot') or ''))
        check('unmatched item has no Edit or Delete button', page.locator('[data-act=devedit]').count() == 0 and page.locator('.dfoot button').count() == 0)
    finally:
        check('no page errors (scenario 9)', not errors, str(errors[:3]))
        b.close()


def final_checks():
    check('requests were captured for the safety check', len(ALL_POSTS) > 0)
    bad = [x for x in ALL_POSTS if x.get('target') in ('PnA', 'Master Inventory', 'PCs', 'Summary')]
    check('never writes to PnA, Master Inventory, PCs or Summary', not bad, str(bad))
    check('every request carries a Row ID', all(x.get('rowId') for x in ALL_POSTS))


with sync_playwright() as p:
    scenarios_a(p)
    scenarios_b(p)
final_checks()

print(f'\n{passed} checks passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

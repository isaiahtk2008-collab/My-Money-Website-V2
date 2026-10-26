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

    # (5) a successful one-field edit: Save shows the confirmation screen first, only Confirm sends
    b, page, errors, posts = session({'ok': True, 'updated': ['Bought From']})
    try:
        open_edit(page)
        page.screenshot(path=os.path.join(tempfile.gettempdir(), 'device-edit-popup.png'))
        page.fill('[data-dk="Bought From"]', 'Alex')
        page.click('[data-deform] button[type=submit]')
        page.wait_for_selector('[data-deconfirm]', state='visible')
        deconf_text = page.locator('[data-deconfirm]').text_content() or ''
        check('confirmation screen shows expected text', 'Confirm changes' in deconf_text and 'Sam' in deconf_text and 'Alex' in deconf_text, deconf_text)
        check('no request sent before confirmation', len(posts) == 0, str(posts))
        page.click('[data-de="confirm"]')
        page.wait_for_selector('[data-deconfirm]', state='detached', timeout=5000)
        check('one edit request was sent', len(posts) == 1, str(posts))
        p0 = posts[0] if posts else {}
        check('request is an edit of the Bought tab and that one Row ID', p0.get('action') == 'edit' and p0.get('target') == 'Form Responses - Bought' and p0.get('rowId') == 'ab12', str(p0))
        check('only the changed field is sent', p0.get('changes') == {'Bought From': 'Alex'}, str(p0))
        check('expect holds 2+ unchanged columns', len(p0.get('expect', {})) >= 2 and 'Bought From' not in p0.get('expect', {}), str(p0))
        check('request has no old-style row number', 'row' not in p0)
        check('loaded data updated for that row only', page.evaluate("store.raw.BoughtPhones.rows.map(r=>r['Bought From'])") == ['Alex', 'Sam'])
        check('an Undo button is shown after the save', page.locator('#toasts .toast-undo').is_visible())
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

    # (7) the script refuses: readable error, confirmation screen stays, data unchanged
    b, page, errors, posts = session({'ok': False, 'error': 'no_match'})
    try:
        open_edit(page)
        page.fill('[data-dk="Bought From"]', 'Zed')
        page.click('[data-deform] button[type=submit]')
        page.wait_for_selector('[data-deconfirm]', state='visible')
        page.click('[data-de="confirm"]')
        page.wait_for_timeout(1500)
        msg = page.locator('#ed-msg')
        check('on failure the confirmation screen stays open', page.locator('[data-deconfirm]').count() == 1)
        check('on failure a readable error is shown', msg.is_visible() and bool((msg.text_content() or '').strip()), msg.text_content() or '')
        check('on failure the loaded data is unchanged', page.evaluate("store.raw.BoughtPhones.rows[0]['Bought From']") == 'Sam')
        check('on failure no Undo toast is shown', page.locator('#toasts .toast-undo').count() == 0)
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


SOLD_ROW = {'Timestamp': '2026-10-10T12:00:00', 'Row ID': 'sd56', 'Device Label': 'iPhone 13 - Blue', 'Sale Price': 600, 'Asking Price': 650,
            'Sale Date': '2026-10-10', 'Clicks on Listing': 12, "Buyer's Name": 'Mia', 'Phone Number': None, 'Meetup Location/Address': 'Square One', 'Notes': None}
DECOY_ROW = dict(SOLD_ROW, **{'Row ID': 'sd99', 'Device Label': 'iPhone 12 - Red', "Buyer's Name": 'Bob'})

def load_sold_phone(page):
    return page.evaluate("""([pRow, sRow, dRow]) => {
        let raw = JSON.parse(JSON.stringify(store.raw));
        raw.Phones = {sheet: 'Master Inventory',
            headers: ['Model','IMEI','Status','Device Label','Purchase Price','Purchase Date','Sale Price','Sale Date','Bought From','Color','Condition'],
            rows: [{'Model': 'iPhone 13','IMEI': '356789012345678','Status': 'SOLD','Device Label': 'iPhone 13 - Blue','Purchase Price': 450,
                    'Purchase Date': '2026-09-30','Sale Price': 600,'Sale Date': '2026-10-10','Bought From': 'Sam','Color': 'Blue','Condition': 'Used - Good'}]};
        raw.BoughtPhones = {sheet: 'Form Responses - Bought', headers: Object.keys(pRow), rows: [Object.assign({}, pRow)]};
        raw.SoldPhones = {sheet: 'Form Responses - Sold', headers: Object.keys(sRow), rows: [sRow, dRow]};
        store.set(raw);
        const item = store.D.items.find(x => x.kind === 'Phone');
        return item ? item.id : null;
    }""", [PURCHASE_ROW, SOLD_ROW, DECOY_ROW])

def sold_session(p, reply):
    mode = {'edit': True, 'reply': reply}
    b, page, errors, posts = run(mode, p)
    pid = load_sold_phone(page)
    open_drawer(page, pid)
    page.click('[data-act=devedit]')
    page.wait_for_selector('[data-deform]', state='visible')
    return b, page, errors, posts, mode

def toast_has(page, text, timeout=5000):
    try:
        page.wait_for_function("t => document.querySelector('#toasts').innerText.includes(t)", arg=text, timeout=timeout)
        return True
    except Exception:
        return False

def edit_sale(page, name='Zoe', price=None):
    page.click('[data-tab="sale"]')
    page.fill('[data-dk="Buyer\'s Name"]', name)
    if price is not None:
        page.fill('[data-dk="Sale Price"]', price)
    page.click('[data-deform] button[type=submit]')
    page.wait_for_selector('[data-deconfirm]', state='visible')
    page.click('[data-de="confirm"]')
    page.wait_for_selector('[data-deconfirm]', state='detached', timeout=5000)

def sale_cell(page, col):
    return page.evaluate("c => store.raw.SoldPhones.rows[0][c]", col)

BUYER = '[data-dk="Buyer\'s Name"]'
DONE = 'Undone. Your sheet is back to how it was.'


def scenarios_c(p):
    # (c1) an unsold device has no Edit sale tab
    b, page, errors, posts = run({'edit': True, 'reply': {'ok': True}}, p)
    try:
        open_drawer(page, load_phone(page))
        page.click('[data-act=devedit]')
        page.wait_for_selector('[data-deform]', state='visible')
        check('unsold device: Edit purchase tab is there', page.locator('[data-tab="purchase"]').count() == 1)
        check('unsold device: no Edit sale tab', page.locator('[data-tab="sale"]').count() == 0)
    finally:
        check('no page errors (scenario c1)', not errors, str(errors[:3]))
        b.close()

    # (c2) sold device: both tabs, sale fields come from the matched Sold row, Device Label is not editable
    b, page, errors, posts, mode = sold_session(p, {'ok': True})
    try:
        check('sold device: both tabs are shown', page.locator('[data-tab="purchase"]').count() == 1 and page.locator('[data-tab="sale"]').count() == 1)
        page.click('[data-tab="sale"]')
        check('Edit sale tab is selected', page.locator('[data-tab="sale"]').get_attribute('aria-selected') == 'true')
        check('sale form has 8 fields', page.locator('[data-df]').count() == 8, str(page.locator('[data-df]').count()))
        check('Device Label is not editable', page.locator('[data-df="Device Label"]').count() == 0)
        check('sale price is pre-filled from the Sold row', page.locator('[data-dk="Sale Price"]').input_value() == '600.00')
        check('buyer is pre-filled from the Sold row', page.locator(BUYER).input_value() == 'Mia')
        form_text = page.locator('[data-deform]').text_content() or ''
        check('header names the Sold tab and its Row ID', 'Form Responses - Sold' in form_text and 'sd56' in form_text)
        page.screenshot(path=os.path.join(tempfile.gettempdir(), 'device-edit-sale.png'))
    finally:
        check('no page errors (scenario c2)', not errors, str(errors[:3]))
        b.close()

    # (c3) typed values survive switching tabs
    b, page, errors, posts, mode = sold_session(p, {'ok': True})
    try:
        page.click('[data-tab="sale"]')
        page.fill(BUYER, 'Zoe')
        page.click('[data-tab="purchase"]')
        page.click('[data-tab="sale"]')
        check('edits on a tab are kept after switching away and back', page.locator(BUYER).input_value() == 'Zoe')
    finally:
        check('no page errors (scenario c3)', not errors, str(errors[:3]))
        b.close()

    # (c4) Save only shows the confirmation; Cancel goes back with everything still typed
    b, page, errors, posts, mode = sold_session(p, {'ok': True})
    try:
        page.click('[data-tab="sale"]')
        page.fill(BUYER, 'Zoe')
        page.click('[data-deform] button[type=submit]')
        page.wait_for_selector('[data-deconfirm]', state='visible')
        ct = page.locator('[data-deconfirm]').text_content() or ''
        check("confirmation lists the field, old value and new value", "Buyer's Name" in ct and 'Mia' in ct and 'Zoe' in ct, ct)
        check('nothing is sent before Confirm', len(posts) == 0)
        page.screenshot(path=os.path.join(tempfile.gettempdir(), 'device-edit-confirm.png'))
        page.click('[data-de="cancel"]')
        page.wait_for_selector('[data-deform]', state='visible')
        check('Cancel returns to the form with the typed value', page.locator(BUYER).input_value() == 'Zoe' and len(posts) == 0)
        check('Cancel returns to the Edit sale tab', page.locator('[data-tab="sale"]').get_attribute('aria-selected') == 'true')
    finally:
        check('no page errors (scenario c4)', not errors, str(errors[:3]))
        ALL_POSTS.extend(posts)
        b.close()

    # (c5) + (c6) a sale edit goes to the Sold tab by Row ID, then Undo puts it back
    b, page, errors, posts, mode = sold_session(p, {'ok': True, 'updated': ["Buyer's Name"]})
    try:
        edit_sale(page, 'Zoe')
        check('one edit request was sent', len(posts) == 1, str(posts))
        p0 = posts[0] if posts else {}
        check('request edits the Sold tab by that Row ID', p0.get('action') == 'edit' and p0.get('target') == 'Form Responses - Sold' and p0.get('rowId') == 'sd56', str(p0))
        check('only the changed sale field is sent', p0.get('changes') == {"Buyer's Name": 'Zoe'}, str(p0))
        check('expect holds 2+ unchanged columns', len(p0.get('expect', {})) >= 2 and "Buyer's Name" not in p0.get('expect', {}), str(p0))
        check('local Sold row updated, the decoy row untouched', page.evaluate("store.raw.SoldPhones.rows.map(r=>r[\"Buyer's Name\"])") == ['Zoe', 'Bob'])
        check('the purchase row is untouched', page.evaluate("store.raw.BoughtPhones.rows[0]['Bought From']") == 'Sam')
        check('an Undo button is shown', page.locator('#toasts .toast-undo').is_visible())
        mode['reply'] = {'ok': True}
        page.click('#toasts .toast-undo')
        check('Undo says it is done', toast_has(page, DONE))
        check('Undo sent one undo request with no target and no Row ID', len(posts) == 2 and posts[1].get('action') == 'undo' and 'target' not in posts[1] and 'rowId' not in posts[1], str(posts))
        check('Undo restored the value locally', sale_cell(page, "Buyer's Name") == 'Mia')
    finally:
        check('no page errors (scenario c5/c6)', not errors, str(errors[:3]))
        ALL_POSTS.extend(posts)
        b.close()

    # (c7) the sheet refuses the undo: clear message, one undo call, local data unchanged
    b, page, errors, posts, mode = sold_session(p, {'ok': True, 'updated': ['Sale Price', "Buyer's Name"]})
    try:
        edit_sale(page, 'Zoe', '610')
        check('two-field edit sent both fields', len(posts) == 1 and set(posts[0].get('changes', {})) == {'Sale Price', "Buyer's Name"}, str(posts))
        mode['reply'] = {'ok': False, 'error': 'cell changed since the edit'}
        page.click('#toasts .toast-undo')
        check('refusal text is clear', toast_has(page, 'That cell changed since; nothing was changed.'))
        check('only one undo call is made before stopping', len([x for x in posts if x.get('action') == 'undo']) == 1, str(posts))
        check('local data is left as edited', sale_cell(page, "Buyer's Name") == 'Zoe' and sale_cell(page, 'Sale Price') == 610)
    finally:
        check('no page errors (scenario c7)', not errors, str(errors[:3]))
        ALL_POSTS.extend(posts)
        b.close()

    # (c8) a two-field edit needs two undo calls, and both fields come back
    b, page, errors, posts, mode = sold_session(p, {'ok': True, 'updated': ['Sale Price', "Buyer's Name"]})
    try:
        edit_sale(page, 'Zoe', '610')
        mode['reply'] = {'ok': True}
        page.click('#toasts .toast-undo')
        check('two-field Undo says it is done', toast_has(page, DONE))
        check('two undo calls were sent', len([x for x in posts if x.get('action') == 'undo']) == 2, str(posts))
        check('both fields are back locally', sale_cell(page, "Buyer's Name") == 'Mia' and sale_cell(page, 'Sale Price') == 600)
    finally:
        check('no page errors (scenario c8)', not errors, str(errors[:3]))
        ALL_POSTS.extend(posts)
        b.close()

    # (c9) edits on the other tab are not part of this save, and the person is told
    b, page, errors, posts, mode = sold_session(p, {'ok': True})
    try:
        page.click('[data-tab="sale"]')
        page.fill(BUYER, 'Zoe')
        page.click('[data-tab="purchase"]')
        page.fill('[data-dk="Bought From"]', 'Alex')
        page.click('[data-deform] button[type=submit]')
        page.wait_for_selector('[data-deconfirm]', state='visible')
        ct = page.locator('[data-deconfirm]').text_content() or ''
        check('confirmation warns about the other tab', 'You also have edits on the other tab. They are not part of this save.' in ct, ct)
        check('confirmation lists only this tab', 'Alex' in ct and 'Zoe' not in ct, ct)
        check('nothing is sent', len(posts) == 0)
    finally:
        check('no page errors (scenario c9)', not errors, str(errors[:3]))
        b.close()

    # (c10) an older script that cannot undo: clear message
    b, page, errors, posts, mode = sold_session(p, {'ok': True, 'updated': ["Buyer's Name"]})
    try:
        edit_sale(page, 'Zoe')
        mode['reply'] = {'ok': False, 'error': 'tab not allowed: undefined'}
        page.click('#toasts .toast-undo')
        check('old script gets the update message', toast_has(page, 'Your entry script needs the newest version before it can undo. Nothing was changed.'))
        check('local data is left as edited', sale_cell(page, "Buyer's Name") == 'Zoe')
    finally:
        check('no page errors (scenario c10)', not errors, str(errors[:3]))
        ALL_POSTS.extend(posts)
        b.close()


def final_checks():
    check('requests were captured for the safety check', len(ALL_POSTS) > 0)
    bad = [x for x in ALL_POSTS if x.get('target') in ('PnA', 'Master Inventory', 'PCs', 'Summary')]
    check('never writes to PnA, Master Inventory, PCs or Summary', not bad, str(bad))
    check('every edit request has a valid target and Row ID', all(x.get('target') in {'Form Responses - Bought', 'Form Responses - Sold'} and x.get('rowId') for x in ALL_POSTS if x.get('action') == 'edit'))
    check('every undo request has no target key and no rowId key', all('target' not in x and 'rowId' not in x for x in ALL_POSTS if x.get('action') == 'undo'))
    check('no request has an action other than edit or undo', all(x.get('action') in {'edit', 'undo'} for x in ALL_POSTS))


with sync_playwright() as p:
    scenarios_a(p)
    scenarios_b(p)
    scenarios_c(p)
final_checks()

print(f'\n{passed} checks passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

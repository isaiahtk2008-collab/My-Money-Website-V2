# Run with: python3 tests/ui-device-edit.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script and injected Bought-tab rows. Proves the device drawer's Edit/Delete footer,
# the "Edit purchase" popup, the one-row edit request, and that nothing but the two Bought tabs is ever targeted. Never touches Google.
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
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
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
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri())
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}')")
    return b, page, errors, posts

FIND_PHONE = "()=>{const it=store.D.items.find(i=>i.kind==='Phone'&&!i.sold&&i.specs&&i.specs.IMEI);return {id:it.id,name:it.name,imei:it.specs.IMEI}}"
INJECT = "(d)=>store.set(Object.assign({}, store.raw, {BoughtPhones: d}))"
UNSAFE = ['PnA', 'Master Inventory', 'PCs', 'Summary']
BOUGHT = ['Form Responses - Bought', 'Form Responses - PCs']

mode = {'edit': True, 'reply': {'ok': True, 'row': 2}}
pathlib.Path('/tmp/claude-0').mkdir(parents=True, exist_ok=True)

def drawer_text(page): return page.locator('#overlay').inner_text()
def open_drawer(page, pid): page.evaluate("(id)=>openDetail(id)", pid); page.wait_for_selector('#overlay .drawer')
def open_edit(page, pid):
    open_drawer(page, pid); page.locator('[data-act=devedit]').click(); page.wait_for_selector('form[data-devform]')
def close(page): page.keyboard.press('Escape'); page.wait_for_function("document.querySelectorAll('#overlay *').length===0")

with sync_playwright() as p:
    b, page, errors, posts = run(mode, p)
    phone = page.evaluate(FIND_PHONE)
    fields = page.evaluate("window.__mmLog.FORMS.find(f=>f.id==='bphone').f.map(f=>({k:f.k,r:!!f.r}))")
    headers = ['Timestamp'] + [f['k'] for f in fields] + ['Row ID']
    price_i = next(i for i, f in enumerate(fields) if f['k'] == 'Purchased Price')
    notes_i = next(i for i, f in enumerate(fields) if f['k'] == 'Notes')

    def bought(row_id):
        row = {f['k']: None for f in fields}
        row.update({'Timestamp': '2026-09-01T10:00:00', 'Serial Number': phone['imei'], 'Phone Model': phone['name'], 'Color': 'Black', 'Storage (GB)': 256,
                    'Condition': 'Used - Good', 'Screen Condition': 'Pristine', 'Original Box': 'Yes', 'Charger': 'Yes', 'Case': 'No', 'Purchased Price': 300,
                    'Purchase Date': '2026-09-01', 'Bought From': 'David Dwornik', 'Meetup Location / Address': 'Square One', 'Row ID': row_id})
        return {'sheet': 'Form Responses - Bought', 'headers': headers, 'rows': [row]}

    # ---- 1. no Bought data loaded: nothing to match, so no buttons and a plain message ----
    open_drawer(page, phone['id'])
    t = drawer_text(page)
    check("unmatched device: plain message, no Edit/Delete, 'Sheet row' line kept",
          "Can't safely match this item to its sheet row" in t and page.locator('[data-act=devedit]').count() == 0
          and page.locator('.dfoot button').count() == 0 and 'Sheet row' in t, t[:120])
    close(page)

    # ---- 2. matched device with a Row ID: Delete (disabled, left) and Edit (right) ----
    page.evaluate(INJECT, bought('R-1'))
    phone = page.evaluate(FIND_PHONE)
    open_drawer(page, phone['id'])
    d, ed = page.locator('.dfoot button.danger'), page.locator('[data-act=devedit]')
    check('one Delete and one Edit button', d.count() == 1 and ed.count() == 1)
    check('Delete is disabled', d.is_disabled())
    bd, be = d.bounding_box(), ed.bounding_box()
    check('Delete is bottom-left and Edit is bottom-right', bd['x'] < be['x'] and abs(bd['y'] - be['y']) < 4, f'{bd} {be}')
    check('Delete uses the destructive style, Edit the primary style',
          'danger' in d.get_attribute('class') and 'sec' not in ed.get_attribute('class') and 'danger' not in ed.get_attribute('class'))
    check('the "do it in Google Sheets" note is shown', 'Delete purchases and sales directly in Google Sheets for now' in drawer_text(page))
    n = len(posts)
    try: d.click(force=True, timeout=1000)
    except Exception: pass
    check('clicking the disabled Delete sends nothing and opens nothing', len(posts) == n and page.locator('form[data-devform]').count() == 0)
    check('the expense-only row buttons are not used on a device', page.locator('[data-act=rowdel]').count() == 0 and page.locator('[data-act=rowedit]').count() == 0)
    page.screenshot(path='/tmp/claude-0/device-drawer.png')

    # ---- 3. the popup ----
    ed.click(); page.wait_for_selector('form[data-devform]')
    tabs = page.locator('#overlay [role=tab]')
    check("popup has exactly one tab, 'Edit purchase'", tabs.count() == 1 and tabs.first.inner_text().strip() == 'Edit purchase')
    labels = page.locator('#overlay form label').all_inner_texts()
    want = [f['k'] + (' *' if f['r'] else '') for f in fields]
    check('fields and labels are the purchase form, in order', labels == want, str(labels))
    check('popup is pre-filled from the matched Bought row', page.input_value('#dv-0') == phone['imei'] and page.input_value(f'#dv-{price_i}') == '300')
    page.screenshot(path='/tmp/claude-0/device-edit.png')

    # ---- 4. save: only the changed field, by rowId, to the Bought tab ----
    page.fill(f'#dv-{price_i}', '350'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1] if posts else {}
    check('exactly one request was sent', len(posts) == 1, str(posts))
    check('edit request: action, Bought tab, rowId, no row number',
          req.get('action') == 'edit' and req.get('target') == 'Form Responses - Bought' and req.get('rowId') == 'R-1' and 'row' not in req, str(req))
    check('edit request changes only the price', req.get('changes') == {'Purchased Price': 350}, str(req))
    check('edit request guards with 2+ other columns', len(req.get('expect', {})) >= 2 and 'Purchased Price' not in req.get('expect', {}), str(req))
    check('request never targets a formula tab', req.get('target') in BOUGHT and req.get('target') not in UNSAFE)
    check('screens hold the new price immediately', page.evaluate("(store.base||store.raw).BoughtPhones.rows[0]['Purchased Price']") == 350)

    # ---- 5. validation ----
    n = len(posts)
    open_edit(page, phone['id'])
    page.fill(f'#dv-{price_i}', 'abc'); page.locator('#overlay button[type=submit]').click()
    check('a bad price is rejected in the form without sending', len(posts) == n and page.locator('.ed-f.bad').count() == 1)
    page.fill(f'#dv-{price_i}', '-5'); page.locator('#overlay button[type=submit]').click()
    check('a negative price is rejected without sending', len(posts) == n and page.locator('.ed-f.bad').count() == 1)
    close(page)

    # ---- 6. the sheet refuses ----
    mode['reply'] = {'ok': False, 'error': 'row changed'}
    open_edit(page, phone['id'])
    page.fill(f'#dv-{notes_i}', 'hello'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_selector('#ed-msg:not([hidden])')
    check('a changed row is refused with a clear message and nothing is updated',
          'changed' in page.locator('#ed-msg').inner_text() and page.evaluate("(store.base||store.raw).BoughtPhones.rows[0]['Notes']") is None)
    close(page)

    # ---- 7. old script ----
    mode['edit'] = False; mode['reply'] = {'ok': True}
    n = len(posts)
    open_edit(page, phone['id'])
    page.fill(f'#dv-{notes_i}', 'x'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_selector('#ed-msg:not([hidden])')
    check('an old script is blocked before any request is sent', 'newest version' in page.locator('#ed-msg').inner_text() and len(posts) == n)
    close(page); mode['edit'] = True

    # ---- 8. row has no Row ID yet ----
    page.evaluate(INJECT, bought(''))
    phone = page.evaluate(FIND_PHONE)
    open_drawer(page, phone['id'])
    check('empty Row ID: asks for the backfill and shows no Edit', 'Run the ID backfill first' in drawer_text(page) and page.locator('[data-act=devedit]').count() == 0)
    close(page)

    # ---- 9. accessory ----
    acc = page.evaluate("(()=>{const it=store.D.items.find(i=>i.kind==='Accessory');return it?it.id:null})()")
    if acc:
        open_drawer(page, acc)
        check('accessory: plain message and no Edit', "Can't safely match this item to its sheet row" in drawer_text(page) and page.locator('[data-act=devedit]').count() == 0)
        close(page)
    else:
        print('skip - no accessory item in the sample data')

    # ---- 10. phone-width layout ----
    page.set_viewport_size({'width': 390, 'height': 800})
    page.evaluate(INJECT, bought('R-1'))
    phone = page.evaluate(FIND_PHONE)
    open_edit(page, phone['id'])
    sb = page.locator('#overlay button[type=submit]').bounding_box()
    check('popup fits a 390px screen with no sideways scroll',
          sb is not None and sb['x'] + sb['width'] <= 390 and page.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"), str(sb))
    close(page)

    check('no page errors', not errors, str(errors[:3]))
    b.close()

print(f'\n{passed} checks passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

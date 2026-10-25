# Run with: python3 tests/ui-row-actions.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script. Proves the popout Edit/Delete buttons, the confirmation,
# the one-row requests, the safety refusals, and the interactive Data health ring and issue fix menu. Never touches Google.
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

with sync_playwright() as p:
    mode = {'edit': True, 'reply': {'ok': True, 'row': 0}}
    b, page, errors, posts = run(mode, p)
    n0 = page.evaluate("store.D.expenses.length")
    e = page.evaluate("(()=>{const o=store.D.expenses[2];return {id:o.id,row:o.row,item:o.item,amount:o.amount,place:o.place}})()")

    # ---- footer layout ----
    page.evaluate(f"openDetail('{e['id']}')")
    d, ed = page.locator('[data-act=rowdel]'), page.locator('[data-act=rowedit]')
    check('popout has a Delete and an Edit button', d.count() == 1 and ed.count() == 1)
    bd, be = d.bounding_box(), ed.bounding_box()
    check('Delete is bottom-left and Edit is bottom-right', bd['x'] < be['x'] and abs(bd['y'] - be['y']) < 4, f'{bd} {be}')
    check('Delete uses the tonal destructive style, Edit the primary style',
          'danger' in d.get_attribute('class') and 'sec' not in ed.get_attribute('class') and 'danger' not in ed.get_attribute('class'))
    page.screenshot(path='/tmp/claude-0/popout.png')

    # ---- delete: cancel sends nothing ----
    d.click()
    check('confirmation asks the exact question', 'Are you sure you want to delete this row from your Google Sheet?' in page.locator('#overlay').inner_text())
    page.locator('#overlay [data-act=close][data-focus]').click()
    check('Cancel sends nothing and keeps the row', len(posts) == 0 and page.evaluate("store.D.expenses.length") == n0)

    # ---- delete: confirm removes exactly that row ----
    page.evaluate(f"openDetail('{e['id']}')"); page.locator('[data-act=rowdel]').click()
    page.locator('[data-act=rowdelgo]').click()
    page.wait_for_function(f"store.D.expenses.length=={n0-1}")
    req = posts[-1]
    check('delete request targets only Expenses and that one row', req['action'] == 'delete' and req['target'] == 'Expenses' and req['row'] == e['row'], str(req))
    check('delete request carries an expect guard of 3 columns', set(req['expect']) == {'Item Purchased', 'Amount', 'Date of Purchase'})
    check('delete request never uses the add-row fields', 'tab' not in req and 'values' not in req)
    check('no Row ID column in the loaded data: the old delete body, no rowId key', 'rowId' not in req, str(req))
    check('state syncs immediately: the row is gone and dialog closed', page.locator('#overlay *').count() == 0 and page.evaluate(f"!store.D.byId.has('{e['id']}')||store.D.byId.get('{e['id']}').o.item!=={json.dumps(e['item'])}"))

    # ---- edit: only changed fields are sent ----
    e2 = page.evaluate("(()=>{const o=store.D.expenses[4];return {id:o.id,row:o.row,item:o.item,amount:o.amount}})()")
    page.evaluate(f"openDetail('{e2['id']}')"); page.locator('[data-act=rowedit]').click()
    labels = page.locator('#overlay label').all_inner_texts()
    check('expense edit form has Amount, Date, Where, Paid with, Category, Type', labels == ['Amount', 'Date', 'Where', 'Paid with', 'Category', 'Type'], str(labels))
    page.fill('#ed-amt', '123.45'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1]
    check('edit request changes only Amount', req['action'] == 'edit' and req['changes'] == {'Amount': 123.45} and req['row'] == e2['row'], str(req))
    check('no Row ID column in the loaded data: the old edit body, no rowId key', 'rowId' not in req, str(req))
    check('screens show the new amount immediately', page.evaluate(f"store.D.expenses.find(x=>x.row=={e2['row']}-1||x.id==='{e2['id']}')!==undefined") and
          page.evaluate("store.D.expenses.some(x=>x.amount===123.45)"))

    # ---- edit validation + no-op ----
    page.evaluate(f"openDetail('{e2['id']}')"); page.locator('[data-act=rowedit]').click()
    n_posts = len(posts)
    page.fill('#ed-amt', 'abc'); page.locator('#overlay button[type=submit]').click()
    check('bad amount is rejected in the form without sending', len(posts) == n_posts and page.locator('.ed-f.bad').count() == 1)
    page.keyboard.press('Escape')

    # ---- row changed in the sheet -> refused, UI untouched ----
    mode['reply'] = {'ok': False, 'error': 'row changed'}
    before = page.evaluate("JSON.stringify(store.D.expenses.map(x=>[x.id,x.amount]))")
    e3 = page.evaluate("store.D.expenses[5].id")
    page.evaluate(f"openDetail('{e3}')"); page.locator('[data-act=rowdel]').click(); page.locator('[data-act=rowdelgo]').click()
    page.wait_for_selector('#ed-msg:not([hidden])')
    check('a changed row is refused with a clear message and nothing is removed',
          'changed' in page.locator('#ed-msg').inner_text() and page.evaluate("JSON.stringify(store.D.expenses.map(x=>[x.id,x.amount]))") == before)
    page.keyboard.press('Escape')

    # ---- old script (no edit support) -> blocked before any POST ----
    mode['edit'] = False; mode['reply'] = {'ok': True}
    n_posts = len(posts)
    page.evaluate(f"openDetail('{e3}')"); page.locator('[data-act=rowdel]').click(); page.locator('[data-act=rowdelgo]').click()
    page.wait_for_selector('#ed-msg:not([hidden])')
    check('an old script is detected and nothing is sent', len(posts) == n_posts and 'newest version' in page.locator('#ed-msg').inner_text())
    page.keyboard.press('Escape')

    # ---- Row ID column present: sent with row + expect; an empty ID gets no buttons and a note ----
    mode['edit'] = True; mode['reply'] = {'ok': True, 'row': 0}
    r_empty, r_edit, r_del = [page.evaluate(f"store.D.expenses[{i}].row") for i in (3, 4, 5)]
    page.evaluate(f"""(()=>{{const raw=JSON.parse(JSON.stringify(store.base||store.raw));const t=raw.Expenses;t.headers.push('Row ID');
      t.rows.forEach((r,i)=>{{r['Row ID']='rui'+i}});t.rows[{r_empty}-2]['Row ID']=null;store.set(raw)}})()""")
    by_row = lambda n: page.evaluate(f"store.D.expenses.find(x=>x.row=={n}).id")
    page.evaluate(f"openDetail('{by_row(r_empty)}')")
    check('empty Row ID: no Edit or Delete, and the note is shown',
          page.locator('[data-act=rowdel]').count() == 0 and page.locator('[data-act=rowedit]').count() == 0 and 'Run the ID backfill first' in page.locator('#overlay').inner_text())
    page.keyboard.press('Escape')
    n_posts = len(posts)
    page.evaluate(f"openDetail('{by_row(r_edit)}')")
    check('with a Row ID the popout names the row by its ID, not the bare number', f'ID rui{r_edit-2} (row {r_edit})' in page.locator('#overlay').inner_text())
    page.locator('[data-act=rowedit]').click(); page.fill('#ed-amt', '77.7'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1]
    check('edit request carries rowId plus row and expect', len(posts) == n_posts + 1 and req['rowId'] == f'rui{r_edit-2}' and req['row'] == r_edit and set(req['expect']) == {'Item Purchased', 'Amount', 'Date of Purchase'} and req['changes'] == {'Amount': 77.7}, str(req))
    page.evaluate(f"openDetail('{by_row(r_del)}')"); page.locator('[data-act=rowdel]').click()
    check('delete confirmation names the row by its ID', f'ID rui{r_del-2} (row {r_del})' in page.locator('#overlay').inner_text())
    page.locator('[data-act=rowdelgo]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1]
    check('delete request carries rowId plus row and expect', req['action'] == 'delete' and req['rowId'] == f'rui{r_del-2}' and req['row'] == r_del and set(req['expect']) == {'Item Purchased', 'Amount', 'Date of Purchase'}, str(req))

    # ---- items / investments have no write buttons yet ----
    it = page.evaluate("store.D.items[0].id")
    page.evaluate(f"openDetail('{it}')")
    check('reselling items do not show row write buttons (formula tabs are protected)', page.locator('[data-act=rowdel]').count() == 0)
    page.keyboard.press('Escape')

    # ---- Data section ----
    page.evaluate("go('data')")
    segs = page.locator('.dh-seg')
    check('health ring segments are interactive', segs.count() >= 1 and segs.first.get_attribute('role') == 'button')
    total = page.locator('.iss-btn').count()
    page.locator('.dh-stat.warn, .dh-stat').first.click()
    filtered = page.locator('.iss-btn').count()
    check('clicking a health status filters the issue list', filtered <= total and page.locator('.dh-stat[aria-pressed=true]').count() == 1)
    segs.first.click(force=True)
    check('clicking a ring segment filters too', page.evaluate("S.dhf") in ('warn', 'info', 'fixed'))
    page.locator('[data-act=dhfilter][data-f=all]').first.click()
    page.locator('.iss-btn').first.click()
    check('an issue card opens the fix menu', 'Fix this issue' in page.locator('#overlay').inner_text())
    page.screenshot(path='/tmp/claude-0/fix.png')
    page.keyboard.press('Escape')
    check('no page errors', not errors, str(errors[:3]))
    b.close()

print(f'\n{passed} checks passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

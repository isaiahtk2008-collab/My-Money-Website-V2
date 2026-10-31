# Run with: python3 tests/ui-owed.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script (never touches Google). Proves the Owed screen (Loans and Deposits, ONE sheet tab named Owed):
# the empty state before the two tabs exist, the numbers and ordering, safe escaping of names, every update request (only edit, only
# Owed, never delete), refusals, no-op saves, the Add buttons, that the other screens still load, and the phone-width nav bar.
import datetime, json, pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.example/exec'
SHOTS = pathlib.Path('/tmp/claude-0')
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

def day(n):
    return (datetime.date.today() + datetime.timedelta(days=n)).isoformat()

def sample_raw_js():
    def row(n, rid, typ, person, item, total, paid, out, due, status=None, closed=None):
        return {'Timestamp': out, 'Row ID': rid, 'Type': typ, 'Person': person, 'Phone / Email': None, 'Item / Device': item, 'Total Amount': total,
                'Amount Paid': paid, 'Date Out': out, 'Due Date': due, 'Status': status, 'Date Closed': closed, 'Notes': None, '_row': n}
    rows = [
        row(2, 'L1', 'Loan', 'Sam', 'ThinkPad T480', 200, None, day(-30), day(-5)),
        row(3, 'L2', 'Loan', 'Alex', None, 100, 40, day(-3), day(10), 'Out'),
        row(4, 'L3', 'Loan', 'Casey', 'Mouse', 30, 30, day(-60), day(-40), 'Returned', day(-41)),
        row(5, 'L4', 'Loan', '<img src=x onerror=window.__xss=1>', None, 10, None, day(-1), None),
        row(6, None, 'Loan', 'NoIdPerson', None, 5, None, day(-2), day(3)),
        {'Timestamp': None, 'Row ID': None, 'Type': None, 'Person': None, 'Total Amount': None, '_row': 7},   # empty spare row
        row(8, 'D1', 'Deposit', 'Jordan', 'Surface Laptop 4', 900, 200, day(-4), day(2)),
        row(9, 'D2', 'Deposit', 'Riley', 'Pixel 9 Pro', 700, 100, day(-20), day(-2), 'Waiting'),
        row(10, 'D3', 'Deposit', 'Morgan', 'MacBook Air', 800, 150, day(-50), day(-30), 'Picked Up', day(-31)),
        row(11, 'X1', None, 'Mystery', 'Unknown thing', 20, None, day(-5), None),   # has a name but no Type: not shown, but counted in a note
    ]
    return json.dumps({'Owed': {'sheet': 'Owed', 'headers': [], 'rows': rows}})

def run(mode_holder, p, width=1100, height=800):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': width, 'height': height})
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
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route(URL + '*', script)
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri())
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}')")
    return b, page, errors, posts

def load_sample(page):
    page.evaluate(f"store.set(Object.assign({{}}, store.raw, {sample_raw_js()}))")
    page.evaluate("go('owed')")
    page.wait_for_selector('#view [data-lg=open]')

with sync_playwright() as p:
    mode = {'edit': True, 'reply': {'ok': True, 'row': 0}}
    b, page, errors, posts = run(mode, p)

    # ---- the other screens are untouched ----
    names = page.evaluate("VIEW_NAMES")
    check('the six original screens keep their order and Owed is added last', names == ['home', 'spending', 'reselling', 'inventory', 'investing', 'data', 'owed'], str(names))
    for v in ['home', 'spending', 'reselling', 'inventory', 'investing', 'data']:
        page.evaluate(f"go('{v}')")
        check(f'{v} screen still renders with no errors', page.locator('#view *').count() > 5 and not errors, str(errors))
    check('the nav rail has seven buttons', page.locator('#rail button.nav').count() == 7)

    # ---- empty state: the two tabs do not exist yet (embedded snapshot) ----
    page.evaluate("go('owed')")
    txt = page.locator('#view').inner_text()
    check('empty state explains the one tab to add and its header row', 'Owed' in txt and 'Row ID' in txt and 'Type' in txt and 'Due Date' in txt and 'Total Amount' in txt)
    check('empty state has no Add or Update buttons and no errors', page.locator('[data-owed-add],[data-owed-edit]').count() == 0 and not errors, str(errors))

    # ---- numbers, ordering, escaping ----
    load_sample(page)
    kp = page.locator('#view .kpi').all_inner_texts()
    flat = ' | '.join(' '.join(k.split()) for k in kp).replace('$', '')
    # open loans: Sam 200, Alex 60 (100-40), '<img>' 10, NoIdPerson 5 -> 275 owed; overdue: Sam + Riley = 2; held: 200+100 = 300; balance 700+600 = 1,300
    check('Owed to you adds the open loan balances (275) and counts 4 open loans', '275' in flat and '4 open loans' in flat, flat)
    check('Overdue counts the overdue loan and the overdue deposit (2)', 'Overdue 2' in flat, flat)
    check('Deposits held is 300 and Due at pickup is 1,300', 'Deposits held 300' in flat and 'Due at pickup 1,300' in flat, flat)
    loan_rows = page.locator('#view .card').nth(4).locator('b').all_inner_texts() if page.locator('#view .card').count() > 5 else []
    body = page.locator('#view').inner_text()
    check('overdue loan is listed before the later-due one, no-date after, closed hidden in details', body.index('Sam') < body.index('NoIdPerson') < body.index('Alex') < body.index('<img'), body)
    check('overdue chips say how many days', '5 days overdue' in body and '2 days overdue' in body)
    check('deposit due soon shows the days left and balance to pay', 'Due in 2 days' in body and 'to pay' in body)
    check('closed items are in a collapsed details block with their count', page.locator('#view details').count() == 2 and 'Closed (1)' in body)
    check('a name with HTML is shown as text and never becomes an element', page.locator('#view img').count() == 0 and page.evaluate("window.__xss") is None and '<img src=x' in body)
    check('a row without a Row ID has no Update button and says so', 'Needs a Row ID' in body and page.locator('[data-owed-edit=loan]').count() == 3)
    check('amounts never show a doubled dollar sign', '$$' not in body, body)
    check('the blank spare row is ignored', 'Borrower' not in body.replace('Add loan', ''))
    check('a row with a name but no Type is not listed and is explained in a note', 'Mystery' not in body and '1 row in the Owed tab has a name but no Type' in body, body)
    page.screenshot(path=str(SHOTS / 'owed-desktop.png'), full_page=True)

    # ---- update a loan: part repayment ----
    page.locator('[data-owed-edit=loan][data-oid=L2]').click()
    check('update dialog has repayment, return-by date and status', page.locator('#overlay label').all_inner_texts() == ['Repayment received', 'Return by', 'Status'])
    page.fill('#owed-pay', '25'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1]
    check('repayment request is an edit on Owed only, by Row ID', req['action'] == 'edit' and req['target'] == 'Owed' and req['rowId'] == 'L2', str(req))
    check('only Amount Paid changes (40 + 25 = 65)', req['changes'] == {'Amount Paid': 65}, str(req))
    check('the safety check carries Row ID, Type, name, total, paid and status', req['expect'] == {'Row ID': 'L2', 'Type': 'Loan', 'Person': 'Alex', 'Total Amount': 100, 'Amount Paid': 40, 'Status': 'Out'}, str(req['expect']))
    check('the screen shows the new balance immediately (35 left on Alex)', '35' in page.locator('#view').inner_text() and page.evaluate("owedModel(store.base||store.raw).loans.find(x=>x.id==='L2').owed") == 35)

    # ---- repay in full: auto Returned + Date Closed ----
    page.locator('[data-owed-edit=loan][data-oid=L1]').click()
    page.fill('#owed-pay', '200'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1]
    check('full repayment marks the loan Returned and stamps today as Date Closed', req['changes'] == {'Amount Paid': 200, 'Status': 'Returned', 'Date Closed': {'$date': day(0)}}, str(req['changes']))
    check('the loan moves to Closed and the totals drop', page.evaluate("owedModel(store.base||store.raw).totals.owedToMe") == 50 and 'Closed (2)' in page.locator('#view').inner_text())

    # ---- no-op and bad input send nothing ----
    n = len(posts)
    page.locator('[data-owed-edit=loan][data-oid=L2]').click()
    page.locator('#overlay button[type=submit]').click()
    check('saving with no change shows a message and sends nothing', len(posts) == n and 'No changes' in page.locator('#ed-msg').inner_text())
    page.fill('#owed-pay', 'abc'); page.locator('#overlay button[type=submit]').click()
    check('a bad amount is rejected in the dialog and sends nothing', len(posts) == n and page.locator('#ed-msg').is_visible())
    page.fill('#owed-pay', '-5'); page.locator('#overlay button[type=submit]').click()
    check('a negative amount is rejected too', len(posts) == n and page.locator('#ed-msg').is_visible())
    page.keyboard.press('Escape')

    # ---- row changed in the sheet: refused, screen untouched ----
    mode['reply'] = {'ok': False, 'error': 'row changed'}
    before = page.evaluate("JSON.stringify((store.base||store.raw).Owed.rows)")
    page.locator('[data-owed-edit=loan][data-oid=L2]').click()
    page.fill('#owed-pay', '5'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_selector('#ed-msg:not([hidden])')
    check('a changed row is refused with a clear message and nothing changes locally', 'changed' in page.locator('#ed-msg').inner_text() and page.evaluate("JSON.stringify((store.base||store.raw).Owed.rows)") == before)
    page.keyboard.press('Escape')
    mode['reply'] = {'ok': True, 'row': 0}

    # ---- old script without edit support: blocked before any POST ----
    mode['edit'] = False; n = len(posts)
    page.locator('[data-owed-edit=loan][data-oid=L2]').click()
    page.fill('#owed-pay', '5'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_selector('#ed-msg:not([hidden])')
    check('an old script is detected before anything is sent', len(posts) == n and 'newest version' in page.locator('#ed-msg').inner_text())
    page.keyboard.press('Escape'); mode['edit'] = True

    # ---- deposits: mark picked up ----
    page.locator('[data-owed-edit=dep][data-oid=D1]').click()
    check('deposit dialog has extra payment, pick-up date and status', page.locator('#overlay label').all_inner_texts() == ['Extra payment received', 'Pick up by', 'Status'])
    page.select_option('#owed-status', 'Picked Up'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1]
    check('deposit pick-up is an edit on Owed only with Status and Date Closed', req['action'] == 'edit' and req['target'] == 'Owed' and req['rowId'] == 'D1' and req['changes'] == {'Status': 'Picked Up', 'Date Closed': {'$date': day(0)}}, str(req))
    check('the deposit guard carries Row ID, Type, name, total, paid', req['expect'] == {'Row ID': 'D1', 'Type': 'Deposit', 'Person': 'Jordan', 'Total Amount': 900, 'Amount Paid': 200}, str(req['expect']))
    page.locator('[data-owed-edit=dep][data-oid=D2]').click()
    page.fill('#owed-pay', '50'); page.fill('#owed-date', day(7)); page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1]
    check('extra payment adds to Amount Paid and a new pick-up date is sent as a Due Date', req['changes'] == {'Amount Paid': 150, 'Due Date': {'$date': day(7)}}, str(req['changes']))

    # ---- the Add buttons open the normal Log forms ----
    page.locator('#view [data-lg=open][data-id=loan]').click()
    labs = ' '.join(page.locator('#overlay label, #overlay .lab, #overlay h2, #overlay legend').all_inner_texts())
    check('Add loan opens the Loan form with its fields', all(x in labs for x in ['Borrower', 'Amount Loaned', 'Date Loaned', 'Return By']), labs)
    check('the Loan form starts with Type set to Loan and no other Type offered', page.locator('#overlay [data-k=Type][aria-pressed=true]').count() == 1 and page.locator('#overlay [data-k=Type]').count() == 1 and page.locator('#overlay [data-k=Type]').inner_text() == 'Loan')
    page.keyboard.press('Escape')
    page.locator('#view [data-lg=open][data-id=dep]').click()
    labs = ' '.join(page.locator('#overlay label, #overlay .lab, #overlay h2, #overlay legend').all_inner_texts())
    check('Add deposit opens the Deposit form with its fields', all(x in labs for x in ['Customer', 'Total Price', 'Deposit Paid', 'Pickup By']), labs)
    check('the Deposit form starts with Type set to Deposit', page.locator('#overlay [data-k=Type][aria-pressed=true]').inner_text() == 'Deposit')
    page.keyboard.press('Escape')

    # ---- safety across everything above ----
    check('no request ever deletes, trades, undoes or adds a row from the Owed screen', all(r.get('action') == 'edit' for r in posts) and len(posts) >= 4, str([r.get('action') for r in posts]))
    check('every request targets only the Owed tab', all(r.get('target') == 'Owed' for r in posts))
    # ---- the Add forms really send a new row for the Owed tab, with the right Type ----
    def wait_post(n):
        for _ in range(60):
            if len(posts) > n: return posts[-1]
            page.wait_for_timeout(100)
        return None
    n = len(posts)
    page.locator('#view [data-lg=open][data-id=loan]').click()
    page.fill('#overlay [data-k="Person"]', 'Pat'); page.fill('#overlay [data-k="Total Amount"]', '300')
    page.locator('#overlay [data-lg=submit]').click()
    req = wait_post(n)
    check('Add loan sends one new row to the Owed tab with Type Loan', req is not None and req.get('tab') == 'Owed' and req['values'].get('Type') == 'Loan' and req['values'].get('Person') == 'Pat' and req['values'].get('Total Amount') == 300, str(req))
    check('the new loan row carries a Date Out and a Due Date', req is not None and '$date' in req['values'].get('Date Out', {}) and '$date' in req['values'].get('Due Date', {}), str(req))
    page.locator('#overlay [data-act=close]').first.click()
    n = len(posts)
    page.locator('#view [data-lg=open][data-id=dep]').click()
    page.fill('#overlay [data-k="Person"]', 'Dana'); page.fill('#overlay [data-k="Item / Device"]', 'iPad'); page.fill('#overlay [data-k="Total Amount"]', '500'); page.fill('#overlay [data-k="Amount Paid"]', '100')
    page.locator('#overlay [data-lg=submit]').click()
    req = wait_post(n)
    check('Add deposit sends one new row to the Owed tab with Type Deposit', req is not None and req.get('tab') == 'Owed' and req['values'].get('Type') == 'Deposit' and req['values'].get('Amount Paid') == 100 and req['values'].get('Total Amount') == 500, str(req))
    page.locator('#overlay [data-act=close]').first.click()
    check('no page errors the whole way through', not errors, str(errors))
    b.close()

    # ---- phone width: seven nav labels must not overlap or run off the screen ----
    for w in (360, 390):
        b, page, errors, posts = run({'edit': True, 'reply': {'ok': True}}, p, width=w, height=760)
        load_sample(page)
        boxes = page.evaluate("""(()=>{const out=[];document.querySelectorAll('#rail button.nav span').forEach(s=>{const r=document.createRange();r.selectNodeContents(s);const t=r.getBoundingClientRect();out.push([s.textContent,Math.round(t.left*10)/10,Math.round(t.right*10)/10])});return out})()""")
        gaps = [boxes[i + 1][1] - boxes[i][2] for i in range(len(boxes) - 1)]
        check(f'{w}px: all seven labels are on screen', len(boxes) == 7 and boxes[0][1] >= 0 and boxes[-1][2] <= w, str(boxes))
        check(f'{w}px: no two nav labels touch or overlap (smallest gap {min(gaps):.1f}px)', min(gaps) >= 1.0, str(boxes))
        check(f'{w}px: the Owed screen does not scroll sideways', page.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"), str(page.evaluate("document.documentElement.scrollWidth")))
        page.screenshot(path=str(SHOTS / f'owed-{w}.png'), full_page=False)
        check(f'{w}px: no page errors', not errors, str(errors))
        b.close()

print(f'\n{passed} checks passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

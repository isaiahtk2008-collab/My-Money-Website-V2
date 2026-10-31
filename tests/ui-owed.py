# Run with: python3 tests/ui-owed.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script (never touches Google). Proves the Owed screen (Loans and Deposits):
# the empty state before the two tabs exist, the numbers and ordering, safe escaping of names, every update request (only edit, only
# Loans or Deposits, never delete), refusals, no-op saves, the Add buttons, that the other screens still load, and the phone-width nav bar.
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
    loans = [
        {'Timestamp': day(-30), 'Row ID': 'L1', 'Borrower': 'Sam', 'Phone / Email': None, 'Item / Device': 'ThinkPad T480', 'Amount Loaned': 200, 'Amount Repaid': None, 'Date Loaned': day(-30), 'Return By': day(-5), 'Status': None, 'Date Closed': None, 'Notes': None, '_row': 2},
        {'Timestamp': day(-3), 'Row ID': 'L2', 'Borrower': 'Alex', 'Phone / Email': None, 'Item / Device': None, 'Amount Loaned': 100, 'Amount Repaid': 40, 'Date Loaned': day(-3), 'Return By': day(10), 'Status': 'Out', 'Date Closed': None, 'Notes': None, '_row': 3},
        {'Timestamp': day(-60), 'Row ID': 'L3', 'Borrower': 'Casey', 'Phone / Email': None, 'Item / Device': 'Mouse', 'Amount Loaned': 30, 'Amount Repaid': 30, 'Date Loaned': day(-60), 'Return By': day(-40), 'Status': 'Returned', 'Date Closed': day(-41), 'Notes': None, '_row': 4},
        {'Timestamp': day(-1), 'Row ID': 'L4', 'Borrower': '<img src=x onerror=window.__xss=1>', 'Phone / Email': None, 'Item / Device': None, 'Amount Loaned': 10, 'Amount Repaid': None, 'Date Loaned': day(-1), 'Return By': None, 'Status': None, 'Date Closed': None, 'Notes': None, '_row': 5},
        {'Timestamp': day(-2), 'Row ID': None, 'Borrower': 'NoIdPerson', 'Phone / Email': None, 'Item / Device': None, 'Amount Loaned': 5, 'Amount Repaid': None, 'Date Loaned': day(-2), 'Return By': day(3), 'Status': None, 'Date Closed': None, 'Notes': None, '_row': 6},
        {'Timestamp': None, 'Row ID': None, 'Borrower': None, 'Amount Loaned': None, '_row': 7},
    ]
    deps = [
        {'Timestamp': day(-4), 'Row ID': 'D1', 'Customer': 'Jordan', 'Phone / Email': None, 'Device': 'Surface Laptop 4', 'Total Price': 900, 'Deposit Paid': 200, 'Date Deposit Taken': day(-4), 'Pickup By': day(2), 'Status': None, 'Date Closed': None, 'Notes': None, '_row': 2},
        {'Timestamp': day(-20), 'Row ID': 'D2', 'Customer': 'Riley', 'Phone / Email': None, 'Device': 'Pixel 9 Pro', 'Total Price': 700, 'Deposit Paid': 100, 'Date Deposit Taken': day(-20), 'Pickup By': day(-2), 'Status': 'Waiting', 'Date Closed': None, 'Notes': None, '_row': 3},
        {'Timestamp': day(-50), 'Row ID': 'D3', 'Customer': 'Morgan', 'Phone / Email': None, 'Device': 'MacBook Air', 'Total Price': 800, 'Deposit Paid': 150, 'Date Deposit Taken': day(-50), 'Pickup By': day(-30), 'Status': 'Picked Up', 'Date Closed': day(-31), 'Notes': None, '_row': 4},
    ]
    return json.dumps({'Loans': {'sheet': 'Loans', 'headers': [], 'rows': loans}, 'Deposits': {'sheet': 'Deposits', 'headers': [], 'rows': deps}})

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
    check('empty state explains the two tabs to add', 'Loans' in txt and 'Deposits' in txt and 'Row ID' in txt and 'Pickup By' in txt and 'Return By' in txt)
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
    page.screenshot(path=str(SHOTS / 'owed-desktop.png'), full_page=True)

    # ---- update a loan: part repayment ----
    page.locator('[data-owed-edit=loan][data-oid=L2]').click()
    check('update dialog has repayment, return-by date and status', page.locator('#overlay label').all_inner_texts() == ['Repayment received', 'Return by', 'Status'])
    page.fill('#owed-pay', '25'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1]
    check('repayment request is an edit on Loans only, by Row ID', req['action'] == 'edit' and req['target'] == 'Loans' and req['rowId'] == 'L2', str(req))
    check('only Amount Repaid changes (40 + 25 = 65)', req['changes'] == {'Amount Repaid': 65}, str(req))
    check('the safety check carries Row ID, name, loaned, repaid and status', req['expect'] == {'Row ID': 'L2', 'Borrower': 'Alex', 'Amount Loaned': 100, 'Amount Repaid': 40, 'Status': 'Out'}, str(req['expect']))
    check('the screen shows the new balance immediately (35 left on Alex)', '35' in page.locator('#view').inner_text() and page.evaluate("owedModel(store.base||store.raw).loans.find(x=>x.id==='L2').owed") == 35)

    # ---- repay in full: auto Returned + Date Closed ----
    page.locator('[data-owed-edit=loan][data-oid=L1]').click()
    page.fill('#owed-pay', '200'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1]
    check('full repayment marks the loan Returned and stamps today as Date Closed', req['changes'] == {'Amount Repaid': 200, 'Status': 'Returned', 'Date Closed': {'$date': day(0)}}, str(req['changes']))
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
    before = page.evaluate("JSON.stringify((store.base||store.raw).Loans.rows)")
    page.locator('[data-owed-edit=loan][data-oid=L2]').click()
    page.fill('#owed-pay', '5'); page.locator('#overlay button[type=submit]').click()
    page.wait_for_selector('#ed-msg:not([hidden])')
    check('a changed row is refused with a clear message and nothing changes locally', 'changed' in page.locator('#ed-msg').inner_text() and page.evaluate("JSON.stringify((store.base||store.raw).Loans.rows)") == before)
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
    check('deposit pick-up is an edit on Deposits only with Status and Date Closed', req['action'] == 'edit' and req['target'] == 'Deposits' and req['rowId'] == 'D1' and req['changes'] == {'Status': 'Picked Up', 'Date Closed': {'$date': day(0)}}, str(req))
    check('the deposit guard carries Row ID, customer, total, paid', req['expect'] == {'Row ID': 'D1', 'Customer': 'Jordan', 'Total Price': 900, 'Deposit Paid': 200}, str(req['expect']))
    page.locator('[data-owed-edit=dep][data-oid=D2]').click()
    page.fill('#owed-pay', '50'); page.fill('#owed-date', day(7)); page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    req = posts[-1]
    check('extra payment adds to Deposit Paid and a new pick-up date is sent as a date', req['changes'] == {'Deposit Paid': 150, 'Pickup By': {'$date': day(7)}}, str(req['changes']))

    # ---- the Add buttons open the normal Log forms ----
    page.locator('#view [data-lg=open][data-id=loan]').click()
    labs = ' '.join(page.locator('#overlay label, #overlay .lab, #overlay h2, #overlay legend').all_inner_texts())
    check('Add loan opens the Loan form with its fields', all(x in labs for x in ['Borrower', 'Amount Loaned', 'Date Loaned', 'Return By']), labs)
    page.keyboard.press('Escape')
    page.locator('#view [data-lg=open][data-id=dep]').click()
    labs = ' '.join(page.locator('#overlay label, #overlay .lab, #overlay h2, #overlay legend').all_inner_texts())
    check('Add deposit opens the Deposit form with its fields', all(x in labs for x in ['Customer', 'Total Price', 'Deposit Paid', 'Pickup By']), labs)
    page.keyboard.press('Escape')

    # ---- safety across everything above ----
    check('no request ever deletes, trades, undoes or adds a row from the Owed screen', all(r.get('action') == 'edit' for r in posts) and len(posts) >= 4, str([r.get('action') for r in posts]))
    check('every request targets only Loans or Deposits', all(r.get('target') in ('Loans', 'Deposits') for r in posts))
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

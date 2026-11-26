# Run with: python3 tests/ui-owed-close-from-plus.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script (never touches Google). Proves: closed loans show profit / loss and the three loan totals,
# the + button lists open loans and deposits, picking one opens the close dialog with a live profit / loss line, and closing sends ONE locked edit on Owed only.
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
        row(2, 'L2', 'Loan', 'Alex', None, 100, 40, day(-3), day(10), 'Out'),
        row(3, 'L3', 'Loan', 'Casey', 'Mouse', 30, 30, day(-60), day(-40), 'Returned', day(-41)),      # even
        row(4, 'L5', 'Loan', 'Pat', None, 10, 15, day(-30), day(-10), 'Returned', day(-9)),            # profit 5
        row(5, 'L6', 'Loan', 'Drew', None, 10, 5, day(-30), day(-10), 'Returned', day(-9)),            # loss 5
        row(6, 'L7', 'Loan', 'Kim', None, 50, 0, day(-30), day(-10), 'Written off', day(-9)),          # loss 50
        row(7, 'D1', 'Deposit', 'Jordan', 'Surface Laptop 4', 900, 200, day(-4), day(2)),
        row(8, 'D3', 'Deposit', 'Morgan', 'MacBook Air', 800, 150, day(-50), day(-30), 'Picked Up', day(-31)),
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
    page.goto(PAGE.as_uri() + '?demo=1')
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
    load_sample(page)

    # ---- profit / loss on the Owed screen ----
    flat = ' | '.join(' '.join(k.split()) for k in page.locator('#view .kpi').all_inner_texts()).replace('$', '')
    check('Loan profit is 5 (one loan paid back more than lent)', 'Loan profit 5' in flat, flat)
    check('Loan losses is 55 (5 short plus 50 written off)', 'Loan losses 55' in flat, flat)
    check('Net from loans is -50 (5 profit minus 55 losses)', 'Net from loans -50' in flat, flat)
    check('existing numbers are unchanged (60 still owed, 1 open loan)', 'Owed to you 60' in flat and '1 open loan' in flat, flat)
    page.locator('#view details > summary', has_text='Closed').first.click()
    body = page.locator('#view').inner_text()
    check('closed loans show Profit, Loss and Even tags', 'Profit' in body and 'Loss' in body and 'Even' in body, body)

    # ---- the + button ----
    page.locator('.lg-fab').click()
    page.wait_for_selector('#overlay .drawer.lg')
    menu = page.locator('#overlay .drawer.lg').inner_text()
    check('the + menu still has Loan out and Deposit taken', 'Loan out' in menu and 'Deposit taken' in menu)
    check('the + menu has Close a loan or deposit with the open count (2)', 'Close a loan or deposit' in menu and '2 open' in menu, menu)
    page.locator('[data-lg=owedclose]').click()
    lst = page.locator('#overlay .drawer.lg').inner_text()
    check('the close list names the open loan and deposit only', 'Alex' in lst and 'Jordan' in lst and 'Casey' not in lst and 'Pat' not in lst, lst)

    # ---- close the loan from the + menu ----
    page.locator('[data-lg=owedpick][data-oid=L2]').click()
    page.wait_for_selector('[data-owedform=loan]')
    check('the dialog says Close loan and starts on Returned', 'Close loan' in page.locator('#overlay').inner_text() and page.input_value('#owed-status') == 'Returned')
    check('before typing, closing short shows a loss of 60', 'Loss' in page.locator('#owed-net').inner_text() and '60' in page.locator('#owed-net').inner_text(), page.locator('#owed-net').inner_text())
    page.fill('#owed-pay', '100')
    check('typing 100 more (140 back on 100 lent) shows a profit of 40', 'Profit' in page.locator('#owed-net').inner_text() and '40' in page.locator('#owed-net').inner_text(), page.locator('#owed-net').inner_text())
    page.select_option('#owed-status', 'Out')
    check('choosing Out hides the preview', page.locator('#owed-net').inner_text().strip() == '')
    page.select_option('#owed-status', 'Returned')
    n = len(posts)
    page.locator('#overlay button[type=submit]').click()
    page.wait_for_function("document.querySelectorAll('#overlay *').length===0")
    check('exactly one request was sent', len(posts) == n + 1, str(posts))
    req = posts[-1]
    check('it is an edit on Owed only, by Row ID', req['action'] == 'edit' and req['target'] == 'Owed' and req['rowId'] == 'L2', str(req))
    check('it sets Amount Paid 140, Returned and today as Date Closed, nothing else', req['changes'] == {'Amount Paid': 140, 'Status': 'Returned', 'Date Closed': {'$date': day(0)}}, str(req['changes']))
    check('the safety check locks the row', req['expect'].get('Row ID') == 'L2' and req['expect'].get('Type') == 'Loan' and req['expect'].get('Amount Paid') == 40, str(req['expect']))
    flat = ' | '.join(' '.join(k.split()) for k in page.locator('#view .kpi').all_inner_texts()).replace('$', '')
    check('the totals update at once: profit 45, losses 55, net -10', 'Loan profit 45' in flat and 'Loan losses 55' in flat and 'Net from loans -10' in flat, flat)

    # ---- close a deposit from the + menu ----
    page.locator('.lg-fab').click(); page.locator('[data-lg=owedclose]').click()
    check('the closed loan is gone from the list and the deposit remains', page.locator('[data-lg=owedpick][data-oid=L2]').count() == 0 and page.locator('[data-lg=owedpick][data-oid=D1]').count() == 1)
    page.locator('[data-lg=owedpick][data-oid=D1]').click()
    page.wait_for_selector('[data-owedform=dep]')
    check('the deposit dialog says Close deposit, starts on Picked Up and shows no profit line', 'Close deposit' in page.locator('#overlay').inner_text() and page.input_value('#owed-status') == 'Picked Up' and page.locator('#owed-net').count() == 0)
    page.locator('#overlay [data-act=close]').first.click(); page.wait_for_function("document.querySelectorAll('#overlay *').length===0")

    # ---- the + button when nothing is open, and the normal Add buttons ----
    page.evaluate("store.set(Object.assign({}, store.raw, {Owed:{sheet:'Owed',headers:[],rows:[]}}))")
    page.locator('.lg-fab').click(); page.locator('[data-lg=owedclose]').click()
    check('with nothing open the list says so', 'Nothing open' in page.locator('#overlay .drawer.lg').inner_text())
    page.locator('[data-lg=menu]').first.click()
    page.locator('#overlay [data-lg=open][data-id=loan]').click()
    check('Loan out still opens its form from the + menu', 'Loan out' in page.locator('#overlay .drawer.lg').inner_text() and page.locator('#overlay input[type=date]').count() >= 2)
    page.locator('#overlay [data-act=close]').first.click(); page.wait_for_function("document.querySelectorAll('#overlay *').length===0")

    # ---- nothing else broke ----
    for v in ['home', 'spending', 'reselling', 'inventory', 'investing', 'data', 'owed']:
        page.evaluate(f"go('{v}')")
        check(f'{v} screen still renders', page.locator('#view *').count() > 5)
    check('no page errors at any point', not errors, str(errors))
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

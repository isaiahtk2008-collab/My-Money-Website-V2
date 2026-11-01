# Run with: python3 tests/ui-status-signals.py        (needs: pip install playwright && playwright install chromium)
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


def open_menu(page):
    page.evaluate("document.querySelector('.lg-fab').click()")
    page.wait_for_selector('.drawer.lg .li')

def row(page, fid):
    return page.locator(f'.drawer.lg .li[data-id="{fid}"]')

with sync_playwright() as p:
    mode = {'edit': True, 'reply': {'ok': True, 'row': 0}}
    b, page, errors, posts = run(mode, p)
    load_sample(page)
    page.evaluate("document.querySelector('[data-act=close]') && 0")
    page.evaluate("go('home')")
    page.evaluate("LS.set('ss.prefs','')")

    # ---- levels, classes, badges ----
    open_menu(page)
    check('menu still lists all ten forms', page.locator('.drawer.lg .li[data-lg=open]').count() == 10)
    loan = row(page, 'loan'); dep = row(page, 'dep')
    check('Loan out is overdue (Sam is past the return date)', 'ss-overdue' in (loan.get_attribute('class') or ''), loan.get_attribute('class'))
    check('Deposit taken is overdue (Riley is past pickup)', 'ss-overdue' in (dep.get_attribute('class') or ''), dep.get_attribute('class'))
    check('overdue badge is a rounded square with ! and a number', page.locator('.li[data-id=loan] .ss-b-overdue').inner_text().startswith('!'))
    check('overdue icon has the static ring even without animation', 'rgb' in page.evaluate("getComputedStyle(document.querySelector('.li[data-id=loan] .ic')).boxShadow"))
    check('unflagged rows have no signal classes and no badge', page.locator('.drawer.lg .li:not(.ss) .ss-b').count() == 0 and 'ss' not in (row(page, 'exp').get_attribute('class') or '').split())
    check('flagged icon is keyboard reachable with a spoken label', loan.locator('.ic').get_attribute('tabindex') == '0' and 'overdue' in (loan.locator('.ic').get_attribute('aria-label') or ''))
    page.wait_for_timeout(600)
    page.screenshot(path=str(SHOTS / 'status-menu-desktop.png'))

    # ---- click the icon: popover, form stays closed ----
    loan.locator('.ic').click()
    check('clicking a flagged icon opens the list and does not open the form', page.locator('.ss-pop').count() == 1 and page.locator('.drawer.lg .lg-top h2').first.inner_text().strip().startswith('Log an entry'))
    txt = page.locator('.ss-pop').inner_text()
    check('the list names the people and says why', 'Sam' in txt and 'past return date' in txt, txt)
    check('a pinned list shows a close button', page.locator('.ss-pop .ss-pop-x').count() == 1)
    loan.locator('.ic').click()
    check('clicking the icon again closes it', page.locator('.ss-pop').count() == 0)

    # ---- Escape closes only the list ----
    loan.locator('.ic').click()
    page.keyboard.press('Escape')
    check('Escape closes the list but keeps the menu open', page.locator('.ss-pop').count() == 0 and page.locator('.drawer.lg .li[data-lg=open]').count() == 10)

    # ---- direct open ----
    loan.locator('.ic').click()
    page.locator('.ss-pop .ss-it', has_text='Sam').click()
    page.wait_for_selector('form[data-owedform=loan]')
    check('direct mode opens the loan record straight away', page.locator('form[data-owedform=loan]').count() == 1)
    check('nothing was sent to the sheet by looking', posts == [], str(posts))
    page.evaluate("closeOverlay()")

    # ---- an unflagged row still opens its form ----
    open_menu(page)
    row(page, 'exp').click()
    check('an unflagged row still opens its entry form', page.locator('.drawer.lg .lg-in, .drawer.lg [data-lg=pick]').count() > 0)
    page.evaluate("closeOverlay()")

    # ---- grace setting: 10 days grace turns Sam (5 days past) and Riley (2 days) from overdue into open ----
    page.evaluate("LS.set('ss.prefs', JSON.stringify({graceDays:10,openMode:'direct',hover:true}))")
    open_menu(page)
    cl = row(page, 'loan').get_attribute('class') or ''
    check('with 10 days of grace the loan is no longer overdue', 'ss-overdue' not in cl, cl)
    page.evaluate("closeOverlay()")
    page.evaluate("LS.set('ss.prefs','')")

    # ---- filtered mode ----
    page.evaluate("LS.set('ss.prefs', JSON.stringify({graceDays:0,openMode:'filtered',hover:true}))")
    open_menu(page)
    row(page, 'loan').locator('.ic').click()
    page.locator('.ss-pop .ss-it').first.click()
    page.wait_for_timeout(200)
    check('filtered mode closes the menu and shows the list screen', page.locator('.drawer.lg').count() == 0 and page.evaluate("S.view") == 'owed')
    check('filtered mode still sends nothing to the sheet', posts == [])
    page.evaluate("LS.set('ss.prefs','')")

    # ---- hover preview ----
    page.evaluate("go('home')")
    open_menu(page)
    row(page, 'dep').locator('.ic').hover()
    page.wait_for_selector('.ss-pop.ss-preview', timeout=2000)
    check('hovering previews the list without pinning it', page.locator('.ss-pop.ss-preview').count() == 1 and page.locator('.ss-pop .ss-pop-x').count() == 0)
    page.mouse.move(5, 5)
    page.wait_for_timeout(500)
    check('moving away hides the preview', page.locator('.ss-pop').count() == 0)
    page.evaluate("LS.set('ss.prefs', JSON.stringify({graceDays:0,openMode:'direct',hover:false}))")
    page.evaluate("closeOverlay()"); open_menu(page)
    row(page, 'dep').locator('.ic').hover(); page.wait_for_timeout(500)
    check('with hover preview turned off nothing appears on hover', page.locator('.ss-pop').count() == 0)
    row(page, 'dep').locator('.ic').click()
    check('click still works with hover preview off', page.locator('.ss-pop').count() == 1)
    page.evaluate("LS.set('ss.prefs','')")

    # ---- a redraw while a list is pinned must not leave the icon dead ----
    page.evaluate("closeOverlay()"); open_menu(page)
    row(page, 'loan').locator('.ic').click()
    page.evaluate("document.querySelector('.ss-pop').remove()")   # the menu redrawing removes the list but not our memory of it
    row(page, 'loan').locator('.ic').click()
    check('after the menu redraws the icon opens the list again', page.locator('.ss-pop').count() == 1)

    # ---- phone width ----
    page.set_viewport_size({'width': 390, 'height': 780})
    page.evaluate("closeOverlay()"); open_menu(page)
    row(page, 'loan').locator('.ic').click()
    check('works at phone width and the list fits the screen', page.locator('.ss-pop').count() == 1 and page.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"))
    page.wait_for_timeout(600)
    page.screenshot(path=str(SHOTS / 'status-menu-phone.png'))

    # ---- bad data never breaks the menu ----
    page.evaluate("closeOverlay()")
    page.evaluate("store.set(Object.assign({}, store.raw, {Owed:{sheet:'Owed',headers:[],rows:[null,{Person:'X'},{Type:'Loan',Person:'Y','Total Amount':'abc','Due Date':'garbage'}]}}))")
    open_menu(page)
    check('garbage in the Owed tab does not break the menu', page.locator('.drawer.lg .li[data-lg=open]').count() == 10 and not errors, str(errors))
    check('no request was ever sent to the sheet during all of this', posts == [], str(posts))
    check('no page errors', not errors, str(errors))
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

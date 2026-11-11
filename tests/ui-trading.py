# Run with: python3 tests/ui-trading.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script (never touches Google). Proves the Trading screen (ONE sheet tab named Trades) and the
# Pre-IPO card on the Investing screen (ONE sheet tab named Pre-IPO): the empty states before the tabs exist, the numbers, safe escaping of sheet text,
# the Add trade and Add IPO bid forms (right tab, right numbers, bad numbers refused), the currency switch, that every other screen still loads,
# and the phone layout.
import datetime, json, pathlib
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.example/exec'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

def day(n):
    return (datetime.date.today() + datetime.timedelta(days=n)).isoformat()

TRADE_COLS = ['Timestamp', 'Row ID', 'Date Opened', 'Asset Type', 'Symbol', 'Direction', 'Status', 'Quantity', 'Entry Price', 'Exit Price', 'Fees', 'Currency', 'Multiplier', 'Option Type', 'Strike', 'Expiry', 'Strategy', 'Date Closed', 'Notes']
IPO_COLS = ['Timestamp', 'Row ID', 'Company', 'Ticker', 'Account', 'Status', 'Date Submitted', 'Bid Closes', 'IPO Date', 'Lockup Expiry', 'Shares Requested', 'Shares Allocated', 'Price Low', 'Price High', 'Final Price', 'Currency', 'Cost Basis', 'Current Price', 'Notes']

def raw_js():
    def trade(n, rid, **kw):
        r = {c: None for c in TRADE_COLS}; r.update({'Row ID': rid, '_row': n}); r.update(kw); return r
    def ipo(n, rid, **kw):
        r = {c: None for c in IPO_COLS}; r.update({'Row ID': rid, '_row': n}); r.update(kw); return r
    trades = [
        trade(2, 'T1', Symbol='AAPL', **{'Asset Type': 'Stock', 'Direction': 'Long', 'Status': 'Open', 'Quantity': 10, 'Entry Price': 180, 'Currency': 'USD', 'Date Opened': day(-3)}),
        trade(3, 'T2', Symbol='ETH', **{'Asset Type': 'Crypto', 'Direction': 'Long', 'Status': 'Closed', 'Quantity': 2, 'Entry Price': 3000, 'Exit Price': 3300, 'Fees': 4, 'Currency': 'USD', 'Date Opened': day(-30), 'Date Closed': day(-25)}),
        trade(4, 'T3', Symbol='BTC', **{'Asset Type': 'Crypto', 'Direction': 'Short', 'Status': 'Closed', 'Quantity': 1, 'Entry Price': 60000, 'Exit Price': 61000, 'Currency': 'USD', 'Date Opened': day(-20), 'Date Closed': day(-18)}),
        trade(5, 'T4', Symbol='SHOP', **{'Asset Type': 'Stock', 'Direction': 'Long', 'Status': 'Closed', 'Quantity': 5, 'Entry Price': 100, 'Exit Price': 120, 'Currency': 'CAD', 'Date Opened': day(-10), 'Date Closed': day(-8)}),
        trade(6, 'T5', Symbol='<img src=x onerror=window.__xss=1>', **{'Asset Type': 'Stock', 'Status': 'Open', 'Quantity': 1, 'Entry Price': 1, 'Currency': 'USD', 'Date Opened': day(-1)}),
        trade(7, None, Symbol='NOID', **{'Status': 'Open', 'Quantity': 1, 'Entry Price': 2, 'Currency': 'USD', 'Date Opened': day(-2)}),
        {c: None for c in TRADE_COLS} | {'_row': 8},   # empty spare row
    ]
    ipos = [
        ipo(2, 'P1', Company='Anthropic', Ticker='ANT', Account='TFSA', Status='Bid placed', **{'Date Submitted': day(-1), 'Bid Closes': day(7), 'IPO Date': day(19), 'Shares Requested': 2, 'Price Low': 70, 'Price High': 78, 'Currency': 'USD'}),
        ipo(3, 'P2', Company='Held Co', Status='Allocated', **{'Shares Allocated': 20, 'Final Price': 100, 'Current Price': 150, 'Lockup Expiry': day(30), 'Currency': 'USD'}),
        ipo(4, 'P3', Company='<script>window.__xss=2</script>', Status='Cancelled', **{'Date Submitted': day(-90)}),
    ]
    return json.dumps({'Trades': {'sheet': 'Trades', 'headers': [], 'rows': trades}, 'PreIPO': {'sheet': 'Pre-IPO', 'headers': [], 'rows': ipos}})

def run(p, width=1100, height=800):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': width, 'height': height})
    page = ctx.new_page()
    errors, posts = [], []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)

    def script(route):
        req = route.request
        if req.method == 'GET':
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'service': 'my-money-entry', 'version': 3, 'read': True, 'edit': True}), headers={'access-control-allow-origin': '*'})
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*'})
        posts.append(json.loads(req.post_data))
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'row': 9, 'rowId': 'NEW1', 'unmatched': []}), headers={'access-control-allow-origin': '*'})
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route(URL + '*', script)
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri() + '?demo=1')
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}')")
    return b, page, errors, posts

def view_text(page):
    return page.inner_text('#view')

with sync_playwright() as p:
    b, page, errors, posts = run(p)

    # ---- before the tabs exist: both screens explain what to add, and nothing else changes ----
    page.evaluate("go('trading')"); page.wait_for_timeout(300)
    t = view_text(page)
    check('no Trades tab: the Trading screen shows the setup note with the header row', 'One tab to add first' in t and 'Trades' in t and 'Row ID' in t and 'Date Opened' in t, t[:300])
    page.evaluate("go('investing')"); page.wait_for_timeout(300)
    t = view_text(page)
    check('no Pre-IPO tab: the Investing screen shows the IPO setup note and still shows its own content', 'IPOs and pre-IPO' in t and 'Pre-IPO' in t and 'Lockup Expiry' in t and 'Money added' in t, t[:300])

    # ---- with data ----
    page.evaluate(f"store.set(Object.assign({{}}, store.raw, {raw_js()}))")
    page.evaluate("go('trading')"); page.wait_for_selector('#view [data-lg=open][data-id=trade]')
    t = view_text(page)
    check('the nav has a Trading tab and it is the active screen', page.locator('#rail button.nav[data-v=trading]').count() == 1 and page.evaluate("S.view") == 'trading')
    check('the page title says Trading', 'Trading' in page.inner_text('#ttl'), page.inner_text('#ttl'))
    check('USD is the default (most trades) and a CAD switch exists', page.locator('[data-trading-cur=USD][aria-pressed=true]').count() == 1 and page.locator('[data-trading-cur=CAD][aria-pressed=false]').count() == 1)
    check('KPI tiles show the headline numbers', all(x in t for x in ['Net P&L', 'Win rate', 'Profit factor', 'Open capital', 'Avg win', 'Avg loss', 'Expectancy', 'Max drawdown']), t[:400])
    check('USD net P&L is the ETH win (+$596) plus the BTC short loss (-$1,000) = -US$404.00', '-US$404.00' in t, t[:500])
    check('the open positions are listed and the closed ones too', 'Open positions' in t and 'Closed trades' in t and 'AAPL' in t and 'ETH' in t and 'BTC' in t)
    check('the CAD trade is NOT mixed into the USD view', 'SHOP' not in t)
    check('a trade with no Row ID says so and cannot be edited', 'Needs a Row ID' in t and page.locator('[data-trade-edit=""]').count() == 0)
    check('trades with a Row ID get an edit button', page.locator('[data-trade-edit=T1]').count() == 1 and page.locator('[data-trade-edit=T2]').count() == 1)
    check('a note explains the hidden / unusable rows (none here: the spare row is silently ignored)', 'is hidden' not in t and 'are hidden' not in t)
    page.locator('[data-trading-cur=CAD]').click(); page.wait_for_timeout(250)
    t = view_text(page)
    check('the CAD switch shows only the CAD trade in C$', 'SHOP' in t and 'AAPL' not in t and '+C$100.00' in t, t[:400])
    page.locator('[data-trading-cur=USD]').click(); page.wait_for_timeout(250)
    check('and back to USD', 'AAPL' in view_text(page) and 'SHOP' not in view_text(page))
    check('hostile text in a symbol is shown as text and never runs', page.evaluate("window.__xss") is None and page.locator('#view img').count() == 0)

    page.evaluate("go('investing')"); page.wait_for_selector('#view [data-lg=open][data-id=ipo]')
    t = view_text(page)
    check('the Investing screen keeps its own content and gains the IPO card', 'Money added' in t and 'IPOs and pre-IPO' in t and 'Anthropic' in t and 'Held Co' in t, t[:300])
    check('the pending bid shows the range, the reserved total and the next date', 'US$70.00–US$78.00' in t and 'Reserved US$140.00–US$156.00' in t and 'Bid window closes in 7 days' in t, t[:800])
    check('the allocated holding shows its gain', '+US$1,000.00' in t and 'Holdings US$3,000.00 on US$2,000.00 cost' in t)
    check('the "not guaranteed" note is shown', 'Bids are requests, not guaranteed' in t)
    check('closed bids are folded away, and hostile text never runs', 'Closed (1)' in t and page.evaluate("window.__xss") is None and page.locator('#view script').count() == 0)
    check('bids with a Row ID get an Update button', page.locator('[data-ipo-edit=P1]').count() == 1 and page.locator('[data-ipo-edit=P2]').count() == 1)

    # ---- every other screen still loads, with no errors ----
    for v in ['home', 'spending', 'reselling', 'inventory', 'data', 'owed']:
        page.evaluate(f"go('{v}')"); page.wait_for_timeout(250)
        check(f'the {v} screen still renders', len(view_text(page)) > 40 and page.evaluate("S.view") == v)

    # ---- the Add forms ----
    def wait_post(n):
        for _ in range(60):
            if len(posts) > n: return posts[-1]
            page.wait_for_timeout(100)
        return None
    page.evaluate("go('trading')"); page.wait_for_selector('#view [data-lg=open][data-id=trade]')
    page.locator('#view [data-lg=open][data-id=trade]').first.click()
    labs = page.inner_text('#overlay')
    check('Add trade opens the Trade form with its fields', all(x in labs for x in ['Symbol', 'Quantity', 'Entry Price', 'Exit Price', 'Direction', 'Currency', 'Multiplier', 'Strike']), labs)
    check('Direction starts on Long, Status on Open, Currency on CAD', page.locator('#overlay [data-k=Direction][aria-pressed=true]').inner_text() == 'Long' and page.locator('#overlay [data-k=Status][aria-pressed=true]').inner_text() == 'Open' and page.locator('#overlay [data-k=Currency][aria-pressed=true]').inner_text() == 'CAD')
    n = len(posts)
    page.fill('#overlay [data-k="Symbol"]', 'BTC'); page.locator('#overlay [data-k="Asset Type"]', has_text='Crypto').click()
    page.fill('#overlay [data-k="Quantity"]', 'abc'); page.fill('#overlay [data-k="Entry Price"]', '65000.25')
    page.locator('#overlay [data-lg=submit]').click(); page.wait_for_timeout(500)
    check('a quantity that is not a number is refused: nothing is sent', len(posts) == n)
    page.fill('#overlay [data-k="Quantity"]', '0.5')
    page.locator('#overlay [data-lg=submit]').click()
    req = wait_post(n)
    v = (req or {}).get('values', {})
    check('Add trade sends ONE new row to the Trades tab', req is not None and req.get('tab') == 'Trades' and len(posts) == n + 1 and 'action' not in req, str(req))
    check('with exact keys, numbers as numbers (0.5 BTC at 65000.25), and the defaults', v.get('Symbol') == 'BTC' and v.get('Asset Type') == 'Crypto' and v.get('Quantity') == 0.5 and v.get('Entry Price') == 65000.25 and v.get('Direction') == 'Long' and v.get('Status') == 'Open' and v.get('Currency') == 'CAD', str(v))
    check('and it carries a Date Opened and never a Row ID or Timestamp of its own', '$date' in v.get('Date Opened', {}) and 'Row ID' not in v and 'Timestamp' not in v, str(v))
    check('the optional dates (Expiry, Date Closed) are NOT filled with today: an open trade is not logged as already closed', 'Expiry' not in v and 'Date Closed' not in v, str(v))
    page.locator('#overlay [data-act=close]').first.click()
    n = len(posts)
    page.evaluate("go('investing')"); page.wait_for_selector('#view [data-lg=open][data-id=ipo]')
    page.locator('#view [data-lg=open][data-id=ipo]').first.click()
    labs = page.inner_text('#overlay')
    check('Add IPO bid opens the IPO form with its fields', all(x in labs for x in ['Company', 'Account', 'Shares Requested', 'Price Low', 'Price High', 'Lockup Expiry']), labs)
    page.fill('#overlay [data-k="Company"]', 'Acme'); page.fill('#overlay [data-k="Shares Requested"]', '2'); page.fill('#overlay [data-k="Price Low"]', '70.5'); page.fill('#overlay [data-k="Price High"]', '78')
    page.locator('#overlay [data-lg=submit]').click()
    req = wait_post(n)
    v = (req or {}).get('values', {})
    check('Add IPO bid sends ONE new row to the Pre-IPO tab with numbers and the defaults', req is not None and req.get('tab') == 'Pre-IPO' and len(posts) == n + 1 and v.get('Company') == 'Acme' and v.get('Shares Requested') == 2 and v.get('Price Low') == 70.5 and v.get('Price High') == 78 and v.get('Status') == 'Bid placed' and v.get('Currency') == 'USD', str(req))
    page.locator('#overlay [data-act=close]').first.click()
    # ---- the edit pop-ups: close a trade, record an IPO allocation; refusals send nothing ----
    page.evaluate("go('trading')"); page.wait_for_selector('[data-trade-edit=T1]')
    n = len(posts)
    page.locator('[data-trade-edit=T1]').click()
    check('Close / edit opens the trade pop-up, prefilled and Open', page.locator('#tr-status').input_value() == 'Open' and page.locator('#tr-exit').input_value() == '' and 'AAPL' in page.inner_text('#overlay'), page.inner_text('#overlay')[:200])
    page.locator('#tr-status').select_option('Closed')
    page.locator('#overlay button[type=submit]').click(); page.wait_for_timeout(300)
    check('closing without an exit price is refused with a plain message and sends nothing', len(posts) == n and 'exit price' in page.inner_text('#ed-msg'), page.inner_text('#ed-msg'))
    page.fill('#tr-exit', '190'); page.fill('#tr-fees', '2')
    page.locator('#overlay button[type=submit]').click()
    req = wait_post(n)
    check('Save sends ONE edit to the Trades tab, by Row ID, with a lock and only the changed columns', req is not None and len(posts) == n + 1 and req.get('action') == 'edit' and req.get('target') == 'Trades' and req.get('rowId') == 'T1'
          and req['expect'] == {'Row ID': 'T1', 'Symbol': 'AAPL', 'Quantity': 10, 'Entry Price': 180} and sorted(req['changes']) == ['Date Closed', 'Exit Price', 'Fees', 'Status'] and req['changes']['Exit Price'] == 190 and req['changes']['Status'] == 'Closed' and '$date' in req['changes']['Date Closed'], str(req))
    page.wait_for_timeout(500)
    t = view_text(page)
    check('the pop-up closes and the screen updates: AAPL is now closed with +US$98.00 (190 - 180 times 10, minus 2 fees)', page.locator('#overlay .palbox').count() == 0 and page.locator('[data-trade-edit=T1]').inner_text() == 'Edit' and '+US$98.00' in t, t[:300])
    n = len(posts)
    page.locator('[data-trade-edit=T1]').click()
    page.locator('#overlay button[type=submit]').click(); page.wait_for_timeout(300)
    check('saving without changing anything says so and sends nothing', len(posts) == n and 'No changes' in page.inner_text('#ed-msg'))
    page.locator('#overlay [data-act=close]').first.click()

    page.evaluate("go('investing')"); page.wait_for_selector('[data-ipo-edit=P1]')
    n = len(posts)
    page.locator('[data-ipo-edit=P1]').click()
    check('Update opens the IPO pop-up prefilled with Bid placed', page.locator('#ipo-status').input_value() == 'Bid placed' and 'Anthropic' in page.inner_text('#overlay'))
    page.locator('#ipo-status').select_option('Allocated')
    page.locator('#overlay button[type=submit]').click(); page.wait_for_timeout(300)
    check('Allocated without shares is refused and sends nothing', len(posts) == n and 'shares' in page.inner_text('#ed-msg'), page.inner_text('#ed-msg'))
    page.fill('#ipo-alloc', '1'); page.fill('#ipo-final', '74')
    page.locator('#overlay button[type=submit]').click()
    req = wait_post(n)
    check('Save sends ONE edit to the Pre-IPO tab, by Row ID, with a lock and only the changed columns', req is not None and len(posts) == n + 1 and req.get('action') == 'edit' and req.get('target') == 'Pre-IPO' and req.get('rowId') == 'P1'
          and req['expect'] == {'Row ID': 'P1', 'Company': 'Anthropic', 'Shares Requested': 2} and req['changes'] == {'Status': 'Allocated', 'Shares Allocated': 1, 'Final Price': 74}, str(req))
    page.wait_for_timeout(500)
    t = view_text(page)
    check('the card updates: Anthropic is Allocated with 1 share at the final price', page.locator('#overlay .palbox').count() == 0 and 'allocated 1 sh' in t and 'final US$74.00' in t, t[-900:])
    check('the pending-bid total no longer counts it as reserved money', 'Reserved' not in t.split('Held Co')[0] or 'US$140.00–US$156.00' not in t, t[:500])

    writes = [r for r in posts if r.get('action') != 'read']
    check('nothing in all of the above ever deleted, traded, undid or touched a row of another tab', all((r.get('tab') or r.get('target')) in ('Trades', 'Pre-IPO') for r in writes) and all(r.get('action') in (None, 'add', 'edit') for r in writes) and not any(r.get('action') in ('delete', 'trade', 'undo') for r in posts), str([(r.get('action'), r.get('tab') or r.get('target')) for r in posts]))
    check('no page errors the whole way through', not errors, str(errors))
    b.close()

    # ---- phone: no sideways scrolling on the new screens, all dock tabs on screen ----
    b, page, errors, posts = run(p, 390, 800)
    page.evaluate(f"store.set(Object.assign({{}}, store.raw, {raw_js()}))")
    for v in ['trading', 'investing']:
        page.evaluate(f"go('{v}')"); page.wait_for_timeout(400)
        sw = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
        check(f'390px: the {v} screen does not scroll sideways', sw[0] <= sw[1], str(sw))
    boxes = page.evaluate("[...document.querySelectorAll('#rail button.nav')].map(b=>{const r=b.getBoundingClientRect();return [b.dataset.v,Math.round(r.left),Math.round(r.right)]})")
    check('390px: the Trading dock tab is on screen', any(x[0] == 'trading' and x[1] >= 0 and x[2] <= 390 for x in boxes), str(boxes))
    check('390px: no page errors', not errors, str(errors))
    b.close()

print(f'\n{passed} checks passed, {len(fails)} failed')
if fails:
    print('FAILED:', fails); raise SystemExit(1)

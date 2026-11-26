# Run with: python3 tests/ui-draft-after-submit.py   (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a FAKE sheet script (never touches Google). Proves that after an entry is sent:
#  - no draft is left behind, even when a slow send lets a draft save fire mid-send
#  - a helper that throws after the send cannot leave the draft (or a stuck "Sending..." form) behind
#  - the finished screen cannot save a draft again, and Ctrl+Enter there cannot send the entry a second time
#  - an entry that was mid-send when the page closed is re-queued once, never duplicated
import json, pathlib, time
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.example/exec'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 430, 'height': 900}).new_page()
    errors, posts = [], []
    delay = {'s': 0.0}
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    def script(route):
        req = route.request
        h = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}
        if req.method == 'GET': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'service': 'my-money-entry', 'version': 3, 'read': True}), headers=h)
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=h)
        posts.append(json.loads(req.post_data))
        if delay['s']: page.wait_for_timeout(int(delay['s'] * 1000))
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True}), headers=h)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route(URL + '*', script)
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri() + '?demo=1')
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.evaluate(f"LS.set('lgUrl','{URL}');LS.set('lgSecret','test-key');LS.set('lg.q','');LS.set('lg.inflight','')")

    def open_exp():
        page.evaluate("document.querySelector('.lg-fab').click()")
        page.wait_for_selector('#overlay [data-lg=open][data-id=exp]')
        page.click('#overlay [data-lg=open][data-id=exp]')
        page.wait_for_selector('input.lg-in[data-k="Amount"]')
    def fill_exp():
        open_exp()
        page.fill('input.lg-in[data-k="Amount"]', '12.50')
        page.click('[data-lg=pick][data-k="Personal or Business Expense?"][data-v="Personal"]')
        page.fill('input.lg-in[data-k="Item Purchased"]', 'Test item')
        page.select_option('select.lg-in[data-k="Category"]', index=1)
        page.fill('input.lg-in[data-k="Establishment"]', 'Test shop')
        page.click('[data-lg=pick][data-k="Payment Method"][data-v="Cash"]')
        page.fill('.lg-in[data-k="Notes"]', 'n')
        page.wait_for_timeout(500)
    def state():
        return page.evaluate("()=>({draft:LS.get('lg.d.exp')||'',infl:LS.get('lg.inflight')||'',q:LS.get('lg.q')||'',done:!!document.querySelector('.lg-done'),sending:!!(document.querySelector('[data-lg=submit]')&&document.querySelector('[data-lg=submit]').textContent.indexOf('Sending')>=0)})")
    exp_posts = lambda: [x for x in posts if x.get('tab') == 'Expenses']

    # ---- 1. normal send; a field event fires mid-send (slow script) and still nothing is left behind
    fill_exp()
    check('draft exists before sending', bool(state()['draft']))
    delay['s'] = 1.5
    page.click('[data-lg=submit]')
    page.wait_for_timeout(600)
    mid = state()
    check('form shows Sending while the script answers', mid['sending'], mid)
    check('draft cleared as soon as the send starts', mid['draft'] == '', mid)
    check('entry is kept as in-flight while sending', bool(mid['infl']), mid)
    page.fill('.lg-in[data-k="Notes"]', 'typed during the send'); page.wait_for_timeout(500)
    check('a field event during the send writes no draft', state()['draft'] == '')
    page.wait_for_selector('.lg-done', timeout=15000); page.wait_for_timeout(600)
    delay['s'] = 0
    s = state()
    check('exactly one post was sent', len(exp_posts()) == 1, posts)
    check('no draft after the send', s['draft'] == '', s)
    check('in-flight marker cleared', s['infl'] == '', s)
    check('nothing left in the waiting queue', s['q'] in ('', '[]'), s)

    # ---- 2. finished screen: Ctrl+Enter cannot send a second time
    before = len(posts)
    page.keyboard.press('Control+Enter'); page.wait_for_timeout(1000)
    check('Ctrl+Enter on the finished screen sends nothing', len(posts) == before, posts[before:])
    check('still no draft on the finished screen', state()['draft'] == '')

    # ---- 3. page closed mid-send: the in-flight entry is re-queued, sent again once, and the marker is cleared
    item = {'id': 'testid123', 'form': 'exp', 'tab': 'Expenses', 'values': {'Amount': '9.99', 'Item Purchased': 'Orphan'}, 'ts': int(time.time() * 1000) - 120000}
    page.evaluate("(it)=>{LS.set('lg.q','');LS.set('lg.inflight',JSON.stringify(it))}", item)
    page.reload(); page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.wait_for_timeout(5000)
    sent = [x for x in posts if x.get('id') == 'testid123']
    check('orphaned in-flight entry was sent again exactly once', len(sent) == 1, posts)
    check('in-flight marker cleared after adopting', (page.evaluate("()=>LS.get('lg.inflight')") or '') == '')
    check('queue empty after the resend', (page.evaluate("()=>LS.get('lg.q')") or '') in ('', '[]'))
    # a fresh in-flight entry (another tab is probably still sending it) is left alone
    fresh = dict(item, id='fresh1', ts=int(time.time() * 1000))
    page.evaluate("(it)=>{LS.set('lg.q','');LS.set('lg.inflight',JSON.stringify(it))}", fresh)
    page.reload(); page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    page.wait_for_timeout(5000)
    check('a fresh in-flight entry is not re-sent', not [x for x in posts if x.get('id') == 'fresh1'], posts)
    check('no page errors', not errors, errors)
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
raise SystemExit(1 if fails else 0)

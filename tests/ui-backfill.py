# Run with: python3 tests/ui-backfill.py        (needs: pip install playwright && playwright install chromium)
# Drives the real page in Chromium with a fake entry script. Proves the one-tap "Fill missing IDs" button on a row with an empty Row ID:
# one {action:'backfill'} request, nothing sent to an older script, clear messages, and rows that already have an ID are unchanged. Never touches Google.
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
            if mode_holder.get('edit'): body['edit'] = True
            if mode_holder.get('backfill'): body['backfill'] = True
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

def setup_table(page):
    r_empty, r_with = [page.evaluate(f"store.D.expenses[{i}].row") for i in (3, 4)]
    page.evaluate(f"""(()=>{{const raw=JSON.parse(JSON.stringify(store.base||store.raw));const t=raw.Expenses;t.headers.push('Row ID');
      t.rows.forEach((r,i)=>{{r['Row ID']='rui'+i}});t.rows[{r_empty}-2]['Row ID']=null;store.set(raw)}})()""")
    by_row = lambda n: page.evaluate(f"store.D.expenses.find(x=>x.row=={n}).id")
    return r_empty, r_with, by_row

with sync_playwright() as p:
    # 1. Successful backfill
    mode1 = {'edit': True, 'backfill': True, 'reply': {'ok': True, 'total': 5, 'counts': {'Expenses': 5}}}
    b, page, errors, posts = run(mode1, p)
    r_empty, r_with, by_row = setup_table(page)
    page.evaluate(f"openDetail('{by_row(r_empty)}')")
    check('S1: the popout still shows the backfill note', 'Run the ID backfill first' in page.locator('#overlay').inner_text())
    check('S1: exactly one Fill missing IDs button', page.locator('button[data-act=idfill]').count() == 1)
    check('S1: button label', 'Fill missing IDs' in page.locator('button[data-act=idfill]').inner_text())
    check('S1: still no Edit or Delete on a row without an ID', page.locator('[data-act=rowdel]').count() == 0 and page.locator('[data-act=rowedit]').count() == 0)
    page.locator('button[data-act=idfill]').click()
    page.locator('#toasts .toast').filter(has_text='Filled 5 missing IDs').wait_for()
    check('S1: exactly 1 POST', len(posts) == 1, str(posts))
    check('S1: the POST is only {secret, action:backfill}', len(posts) == 1 and set(posts[0].keys()) == {'secret', 'action'} and posts[0].get('action') == 'backfill', str(posts))
    check('S1: the popout closed', page.locator('[data-act=idfill]').count() == 0)
    check('S1: no page errors', not errors, str(errors))
    b.close()

    # 2. Nothing to fill
    b, page, errors, posts = run({'edit': True, 'backfill': True, 'reply': {'ok': True, 'total': 0, 'counts': {}}}, p)
    r_empty, r_with, by_row = setup_table(page)
    page.evaluate(f"openDetail('{by_row(r_empty)}')")
    page.locator('button[data-act=idfill]').click()
    page.locator('#toasts .toast').filter(has_text='No empty Row IDs found').wait_for()
    check('S2: says no empty Row IDs were found (not that every row has one)', True)
    check('S2: no page errors', not errors, str(errors))
    b.close()

    # 3. Older script (no backfill support): nothing is sent
    b, page, errors, posts = run({'edit': True, 'reply': {'ok': True}}, p)
    r_empty, r_with, by_row = setup_table(page)
    page.evaluate(f"openDetail('{by_row(r_empty)}')")
    page.locator('button[data-act=idfill]').click()
    page.locator('#toasts .toast').filter(has_text='newest version').wait_for()
    check('S3: an older script is detected and nothing is sent', len(posts) == 0, str(posts))
    check('S3: no page errors', not errors, str(errors))
    b.close()

    # 4. The script refuses
    b, page, errors, posts = run({'edit': True, 'backfill': True, 'reply': {'ok': False, 'error': 'auth'}}, p)
    r_empty, r_with, by_row = setup_table(page)
    page.evaluate(f"openDetail('{by_row(r_empty)}')")
    page.locator('button[data-act=idfill]').click()
    page.locator('#toasts .toast').wait_for()
    check('S4: one request, and a message is shown', len(posts) == 1)
    check('S4: no page errors', not errors, str(errors))
    b.close()

    # 5. A row that already has an ID is unchanged
    b, page, errors, posts = run({'edit': True, 'backfill': True, 'reply': {'ok': True}}, p)
    r_empty, r_with, by_row = setup_table(page)
    page.evaluate(f"openDetail('{by_row(r_with)}')")
    check('S5: Edit and Delete are there', page.locator('[data-act=rowdel]').count() == 1 and page.locator('[data-act=rowedit]').count() == 1)
    check('S5: no Fill missing IDs button', page.locator('[data-act=idfill]').count() == 0)
    check('S5: no page errors', not errors, str(errors))
    b.close()

print(f'\n{passed} checks passed, {len(fails)} failed'); sys.exit(1 if fails else 0)

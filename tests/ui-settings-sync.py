# Run with: python3 tests/ui-settings-sync.py        (needs: pip install playwright && playwright install chromium)
# Opens the real site in two separate Chromium sessions (two "devices") and checks that themes and Appearance choices sync between them
# through a stand-in for the Apps Script web app (newest change wins, same rules as apps-script.gs, which tests/settings-sync.test.mjs
# runs for real). Checks: the page still opens with no JS errors, a theme change on device A reaches device B live (page colors and
# saved value), Appearance choices (glow strength, direction) reach B live, per-device settings (web app link, secret, lockout counters)
# are never sent, nothing is sent over plain http or when the script is too old, and the page keeps working with sync switched off.
# Never touches Google or the sheet: every request to Google is answered by the stand-in.
import json, pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
EXEC = 'https://script.google.com/macros/s/STANDIN/exec'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
INIT_CHART = "window.__charts=[];window.Chart=function(el,cfg){window.__charts.push(cfg);return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"
CORS = {'access-control-allow-origin': '*', 'content-type': 'application/json'}

class StandIn:
    """The Apps Script web app, minimal: settings tab as a dict, newest change wins."""
    def __init__(self, supports=True):
        self.supports, self.rows, self.posts, self.gets, self.reads = supports, {}, [], [], []
    def handle(self, route):
        req = route.request
        url = req.url
        body = json.loads(req.post_data or '{}') if req.method == 'POST' else {}
        if req.method == 'POST' and body.get('action') == 'settings_get':
            self.gets.append(url); self.reads.append(body)
            out = {'ok': True, 'status': 'success', 'version': 3, 'secretSet': False, 'settings': self.mapped()}
        elif req.method == 'POST':
            self.posts.append(body)
            applied, skipped = [], []
            for it in body.get('items', []):
                k, v, t = it.get('k'), it.get('v'), it.get('t')
                if k in self.rows and t <= self.rows[k][1]: skipped.append({'k': k, 'reason': 'older'}); continue
                self.rows[k] = (v, t); applied.append(k)
            out = {'ok': True, 'status': 'success', 'applied': applied, 'skipped': skipped, 'settings': self.mapped()}
        elif 'action=settings' in url:
            self.gets.append(url)
            out = {'ok': True, 'status': 'success', 'version': 3, 'secretSet': False, 'settings': self.mapped()}
        elif 'action=' in url:
            out = {'ok': False, 'error': 'not in this test'}
        else:
            out = {'ok': True, 'service': 'my-money-entry', 'version': 3, 'edit': True}
            if self.supports: out.update({'settings': True, 'settingsSecret': False})
        route.fulfill(status=200, headers=CORS, body=json.dumps(out))
    def mapped(self):
        return {k: {'v': v, 't': t} for k, (v, t) in self.rows.items()}

def new_device(b, standin, scheme='light'):
    ctx = b.new_context(viewport={'width': 1100, 'height': 800}, color_scheme=scheme)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route('https://script.google.com/**', standin.handle)
    page.add_init_script(INIT_AUTH); page.add_init_script(INIT_CHART)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_function(READY)
    return ctx, page, errors

def link(page, url=EXEC):
    # set after the page has loaded so the app does not try to read the sheet from the stand-in
    page.evaluate("u => localStorage.setItem('mm.lgUrl', u)", url)

def sync(page):
    return page.evaluate("window.__mmSettingsSync.syncNow().then(r => ({ok: r.ok, pulled: Array.from(r.pulled), pushed: Array.from(r.pushed)}))")

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---- the page still opens and the module is there ----
    si = StandIn()
    ctxA, A, errA = new_device(b, si)
    ctxB, B, errB = new_device(b, si)
    check('page opens with sync installed (no JS errors)', A.evaluate("typeof window.__mmSettingsSync.syncNow") == 'function' and not errA and not errB, str(errA + errB))
    check('Appearance reload hook exists', A.evaluate("typeof window.__mmHfxReload") == 'function')
    A.wait_for_timeout(1800)
    check('nothing is sent while no web app link is saved', not si.gets and not si.posts)

    link(A); link(B)

    # ---- theme: A changes it with the real Theme button logic, B follows ----
    A.evaluate("cycleTheme()")          # auto -> light
    A.evaluate("cycleTheme()")          # light -> dark
    check('A is dark', A.evaluate("document.documentElement.getAttribute('data-theme')") == 'dark')
    ra = sync(A)
    check('A saved its theme to the sheet', ra['ok'] and 'mm.theme' in ra['pushed'], str(ra))
    check('stand-in holds the theme', si.rows.get('mm.theme', (None,))[0] == 'dark')
    rb = sync(B)
    check('B pulled the theme', 'mm.theme' in rb['pulled'], str(rb))
    check('B changed to dark live (page colors)', B.evaluate("document.documentElement.getAttribute('data-theme')") == 'dark')
    check('B saved value and app state agree', B.evaluate("localStorage.getItem('mm.theme')") == 'dark' and B.evaluate("S.theme") == 'dark')
    check('B was not reloaded', B.evaluate("performance.getEntriesByType('navigation').length") == 1)
    check('B charts were redrawn with the new theme', B.evaluate("window.__charts.length") > 0)

    # ---- no echo ----
    n = len(si.posts)
    sync(B); sync(A)
    check('no echo: nothing is sent back after a pull', len(si.posts) == n)

    # ---- Appearance choices ----
    A.evaluate("window.__mmHfxSet({s: 80, dir: 'top'})")
    ra = sync(A)
    check('A saved glow strength and direction', set(['mm.hfx.s', 'mm.hfx.dir']) <= set(ra['pushed']), str(ra))
    sync(B)
    stB = B.evaluate("window.__mmHfxState()")
    check('B shows glow strength 80 and direction top live', stB['s'] == 80 and stB['dir'] == 'top', str(stB))
    check('B page attributes follow', B.evaluate("document.documentElement.getAttribute('data-hfx-dir')") == 'top' and B.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--hfx-s').trim()") == '80')

    # ---- newest wins when both change ----
    A.wait_for_timeout(30); B.wait_for_timeout(30)
    A.evaluate("window.__mmHfxSet({s: 20})")
    B.wait_for_timeout(30)
    B.evaluate("window.__mmHfxSet({s: 65})")
    sync(A); sync(B); sync(A)
    check('both devices end on the newest value (65)', A.evaluate("window.__mmHfxState().s") == 65 and B.evaluate("window.__mmHfxState().s") == 65)

    # ---- removing a choice (Reset) ----
    B.evaluate("['mm.hfx.s','mm.hfx.dir'].forEach(k => localStorage.removeItem(k))")
    sync(B); sync(A)
    stA = A.evaluate("window.__mmHfxState()")
    check('a removed setting goes back to default on the other device', stA['s'] == 55 and stA['dir'] == 'bottom', str(stA))

    # ---- per-device settings never travel ----
    A.evaluate("localStorage.setItem('mm.lgSecret','TOPSECRET'); localStorage.setItem('mm.auth.f','4'); localStorage.setItem('mm.auth.u','123'); localStorage.setItem('mm.sheetId','SID')")
    A.evaluate("localStorage.setItem('mm.dense','1')")
    sync(A)
    A.evaluate("localStorage.setItem('mm.lgSecret','TOPSECRET')")   # the script password: used to sign each request, never saved as a setting
    A.evaluate("localStorage.setItem('mm.dense','0')")
    sync(A)
    saved = json.dumps([it for body in si.posts for it in body.get('items', [])])      # everything that was saved as a setting
    saved_keys = {it['k'] for body in si.posts for it in body.get('items', [])}
    bad = [x for x in ['TOPSECRET', 'mm.auth.f', 'mm.auth.u', 'mm.sheetId', 'mm.lgUrl', 'mm.lgSecret', 'SID', 'script.google.com'] if x in saved]
    check('link, secret, lockout counters and sheet id are never saved as settings', not bad and not (saved_keys & {'mm.lgUrl', 'mm.lgSecret', 'mm.sheetId', 'mm.auth.f', 'mm.auth.u'}), str(bad))
    check('the secret is only ever sent in the request body (reads too), never in a URL', all(b.get('secret', 'TOPSECRET') in ('', 'TOPSECRET') for b in si.posts) and bool(si.reads) and si.reads[-1].get('secret') == 'TOPSECRET' and not any('secret' in g.lower() or 'TOPSECRET' in g for g in si.gets))
    wire = json.dumps(si.posts) + ' '.join(si.gets)
    check('login record is not sent without a script secret', 'mm.auth.cred' not in wire)

    # ---- a failing connection leaves the page working ----
    ctxC, C, errC = new_device(b, StandIn())
    link(C, 'https://script.google.com/macros/s/OTHER/exec')
    C.route('https://script.google.com/**', lambda r: r.abort())
    rc = sync(C)
    check('sync fails quietly when Google cannot be reached', rc['ok'] is False)
    C.evaluate("cycleTheme()")
    check('the page keeps working after a failed sync', C.evaluate("document.documentElement.getAttribute('data-theme')") == 'light' and not errC, str(errC))
    check('the failed change stays queued', 'mm.theme' in C.evaluate("window.__mmSettingsSync.status().dirty"))

    # ---- old script / plain http ----
    old = StandIn(supports=False)
    ctxD, D, errD = new_device(b, old)
    link(D); D.evaluate("cycleTheme()")
    rd = sync(D)
    check('an old script is detected and nothing is sent', rd['ok'] is False and not old.posts and not old.gets)
    ctxE, E, errE = new_device(b, old)
    link(E, 'http://script.google.com/macros/s/X/exec'); E.evaluate("cycleTheme()")
    sync(E)
    check('plain http is never used', not old.posts and not old.gets)
    check('no JS errors anywhere', not (errA or errB or errC or errD or errE), str(errA + errB + errC + errD + errE))

    b.close()

print(f'\n{passed} checks passed' + (f', {len(fails)} FAILED: {fails}' if fails else ''))
sys.exit(1 if fails else 0)

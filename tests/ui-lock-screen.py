# Run with: python3 tests/ui-lock-screen.py   (needs playwright + chromium)
# Proves the username/password form is only a SCREEN LOCK: with a sheet linked it opens only on a device that holds a sheet session key,
# and it still works as before when no sheet is linked (demo data only). Also checks the "sign-in expired" note and that an expired key
# sends the person back to the sign-in screen. Uses a fake sheet script; never touches Google.
import json, pathlib
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
URL = 'https://script.google.com/macros/s/FAKE/exec'
fails, passed = [], 0
def check(name, ok, extra=''):
    global passed
    if ok: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

def modal_open(page):
    return page.evaluate("(()=>{const m=document.getElementById('auth-modal');return !!m && getComputedStyle(m).display!=='none'})()")
def err(page):
    return page.evaluate("(document.getElementById('auth-error')||{}).textContent||''")

def new_page(b, sheet_ok=True):
    ctx = b.new_context(viewport={'width': 1100, 'height': 800})
    page = ctx.new_page()
    reads = []
    def script(route):
        req = route.request
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*'})
        body = json.loads(req.post_data or '{}') if req.method == 'POST' else {}
        if body.get('action') in ('read', 'check', 'settings_get'):
            reads.append(body)
            out = {'ok': True, 'tabs': {}} if sheet_ok else {'ok': False, 'error': 'auth'}
        else:
            out = {'ok': True, 'service': 'my-money-entry', 'version': 3, 'edit': True}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(out), headers={'access-control-allow-origin': '*'})
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.route('https://script.google.com/**', script)
    return ctx, page, reads

def set_creds(page):
    ok = page.evaluate("window.mmAuth.setCreds('lockuser','lock-pass-123','').then(r=>r.ok)")
    return ok

def try_login(page, user='lockuser', pw='lock-pass-123'):
    page.fill('#auth-user', user); page.fill('#auth-pass', pw)
    page.click('#auth-submit'); page.wait_for_timeout(1500)

with sync_playwright() as p:
    b = p.chromium.launch()

    # 1. sheet linked, NO session key on this device -> the lock refuses, with a clear message
    ctx, page, _ = new_page(b)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_timeout(800)
    check('S1: secure page so hashing works', page.evaluate("window.mmAuth.canHash()"))
    check('S1: credentials saved', set_creds(page))
    page.evaluate(f"localStorage.setItem('mm.lgUrl','{URL}')")
    page.reload(); page.wait_for_timeout(800)
    try_login(page)
    check('S1: correct password does NOT unlock a device with no sheet key', modal_open(page))
    check('S1: it says to sign in with Google first', 'Google' in err(page), err(page))
    ctx.close()

    # 2. sheet linked WITH a session key -> unlocks
    ctx, page, reads = new_page(b)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_timeout(800)
    set_creds(page)
    page.evaluate(f"localStorage.setItem('mm.lgUrl','{URL}'); localStorage.setItem('mm.lgSecret','TOKEN123')")
    page.reload(); page.wait_for_timeout(800)
    try_login(page, pw='wrong-password')
    check('S2: wrong password stays locked', modal_open(page))
    try_login(page)
    check('S2: correct password unlocks a device that holds a sheet key', not modal_open(page))
    page.wait_for_timeout(1500)
    check('S2: the key travels in the POST body, never in a URL', any(r.get('secret') == 'TOKEN123' for r in reads), str(reads[:2]))
    ctx.close()

    # 3. no sheet linked -> works exactly as before (demo data only)
    ctx, page, _ = new_page(b)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_timeout(800)
    set_creds(page); page.reload(); page.wait_for_timeout(800)
    try_login(page)
    check('S3: with no sheet linked the lock still opens (demo data only)', not modal_open(page))
    ctx.close()

    # 4. a rejected key sends the person back to sign-in, with a note, and forgets the key
    ctx, page, _ = new_page(b, sheet_ok=False)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_timeout(800)
    set_creds(page)
    page.evaluate(f"localStorage.setItem('mm.lgUrl','{URL}'); localStorage.setItem('mm.lgSecret','OLDTOKEN')")
    page.reload(); page.wait_for_timeout(800)
    try_login(page)
    page.wait_for_timeout(3000)
    check('S4: when the script refuses the key, the sign-in screen comes back', modal_open(page))
    check('S4: the dead key was forgotten', page.evaluate("localStorage.getItem('mm.lgSecret')") is None)
    check('S4: the person is told why', 'expired' in err(page).lower(), err(page))
    ctx.close()
    b.close()

print(f'\n{passed} checks passed' + (f', {len(fails)} FAILED: {fails}' if fails else ''))
raise SystemExit(1 if fails else 0)

# Run with: python3 tests/ui-guest-link.py   (needs playwright + chromium)
# Proves guest links in the website, with a FAKE sheet script (never touches Google):
#  - opening a guest link shows the read-only banner, hides owner/write controls, removes the key from the address bar
#  - the guest key lives only in that tab (the owner's saved sign-in in the same browser is not touched or overwritten)
#  - a guest page only ever sends "read" (no settings sync, no writes), and owner screens cannot be opened
#  - expired / revoked / invalid links show "This guest link has expired" (or "not valid") instead of the sign-in screen
#  - the owner's Guest access card: allowed durations only, create, copy link, list, end one, end all, and the link round-trips
import json, pathlib, re, secrets, time
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
SID = 'AKfycbFAKEFAKEFAKEFAKEFAKE12345'
URL = f'https://script.google.com/macros/s/{SID}/exec'
OWNER = 'OWNERTOKEN' + 'a' * 54
fails, passed = [], 0
def check(name, ok, extra=''):
    global passed
    if ok: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

def tabs():
    t = {k: {'sheet': k, 'headers': [], 'rows': []} for k in ['Expenses', 'Phones', 'PCs', 'Accessories', 'Investments']}
    for k in ['BoughtPhones', 'BoughtPCs', 'BoughtAccess', 'SoldPhones', 'SoldPCs', 'SoldAccess', 'Owed']:
        t[k] = {'sheet': k, 'headers': [], 'rows': []}
    return t

class Fake:
    def __init__(self): self.guests = {}; self.log = []
    def handle(self, route):
        req = route.request
        h = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=h)
        if req.method != 'POST':
            return route.fulfill(status=200, content_type='application/json', headers=h, body=json.dumps({'ok': True, 'service': 'my-money-entry', 'version': 3, 'edit': True, 'settings': True, 'guests': True}))
        body = json.loads(req.post_data or '{}'); self.log.append(body)
        tok, act = body.get('secret'), body.get('action')
        now = int(time.time() * 1000)
        if tok == OWNER:
            if act == 'read': out = {'ok': True, 'tabs': tabs()}
            elif act == 'settings_get': out = {'ok': True, 'settings': {}}
            elif act == 'guest_create':
                key = secrets.token_hex(32); exp = now + int(body['minutes']) * 60000
                self.guests[key] = {'exp': exp, 'preset': body['preset'], 'id': key[:10]}
                out = {'ok': True, 'key': key, 'id': key[:10], 'exp': exp, 'preset': body['preset']}
            elif act == 'guest_list':
                out = {'ok': True, 'now': now, 'guests': [{'id': g['id'], 'exp': g['exp'], 'preset': g['preset'], 'label': ''} for g in self.guests.values() if g['exp'] > now]}
            elif act == 'guest_revoke':
                if body.get('all'): n = len(self.guests); self.guests = {}
                else:
                    ks = [k for k, g in self.guests.items() if g['id'] == body.get('id')]; n = len(ks)
                    for k in ks: del self.guests[k]
                out = {'ok': True, 'revoked': n}
            else: out = {'ok': True}
        elif tok in self.guests:
            out = {'ok': True, 'tabs': tabs(), 'guest': {'preset': self.guests[tok]['preset'], 'exp': self.guests[tok]['exp']}} if act == 'read' else {'ok': False, 'error': 'view-only'}
        else: out = {'ok': False, 'error': 'auth'}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(out), headers=h)

def new_ctx(b, fake, w=1100, h=800):
    ctx = b.new_context(viewport={'width': w, 'height': h})
    ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    ctx.route('https://script.google.com/**', fake.handle)
    return ctx

def page_in(ctx):
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.errs = errs
    return page

def owner_page(ctx):
    page = page_in(ctx)
    page.goto(PAGE.as_uri()); page.wait_for_timeout(500)
    page.evaluate(f"localStorage.setItem('mm.lgUrl','{URL}'); localStorage.setItem('mm.lgSecret','{OWNER}'); sessionStorage.setItem('user_authenticated','true'); sessionStorage.setItem('mm.auth.method','google')")
    page.reload(); page.wait_for_timeout(1200)
    return page

def link_for(key, exp): return f'#guest={SID}~{key}~{exp}'
def modal_open(page): return page.evaluate("(()=>{const m=document.getElementById('auth-modal');return !!m && getComputedStyle(m).display!=='none'})()")
def visible(page, sel): return page.evaluate("(s)=>[...document.querySelectorAll(s)].some(e=>{const r=e.getBoundingClientRect();return getComputedStyle(e).display!=='none'&&r.width>0&&r.height>0})", sel)

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------- guest side ----------
    fake = Fake(); gkey = secrets.token_hex(32); gexp = int(time.time() * 1000) + 3600_000
    fake.guests[gkey] = {'exp': gexp, 'preset': 'sales', 'id': gkey[:10]}
    ctx = new_ctx(b, fake)
    owner = owner_page(ctx)                               # the owner is signed in, in this same browser
    check('O0: owner page is signed in and loads', not modal_open(owner) and owner.evaluate("localStorage.getItem('mm.lgSecret')") == OWNER)

    g = page_in(ctx); g.goto(PAGE.as_uri() + link_for(gkey, gexp)); g.wait_for_timeout(2500)
    check('G1: guest link opens straight in, no sign-in screen', not modal_open(g))
    check('G1: read-only banner is shown', 'Guest view' in (g.text_content('#guest-banner') or '') and 'read-only' in (g.text_content('#guest-banner') or ''), g.text_content('#guest-banner') or '')
    check('G1: banner says when it ends', 'ends' in (g.text_content('#guest-banner') or ''))
    check('G1: the key is gone from the address bar', g.evaluate("location.hash") == '' and gkey not in g.url, g.url)
    check('G1: page is in guest mode', g.evaluate("document.documentElement.classList.contains('mm-guest')") and g.evaluate("!!window.mmGuest&&window.mmGuest.active"))
    check('G2: owner $ / settings button is hidden', not visible(g, '[data-sec]'))
    check('G2: add/log button and sync pill are hidden', not visible(g, '.lg-fab') and not visible(g, '#syncpill'))
    reads = [x for x in fake.log if x.get('secret') == gkey]
    check('G3: guest page loaded data with the guest key', any(x.get('action') == 'read' for x in reads), str(fake.log[-3:]))
    check('G3: guest page sent ONLY read requests (no settings sync, no writes)', reads and all(x.get('action') == 'read' for x in reads), str([x.get('action') for x in reads]))
    # owner screens cannot be opened even by force
    g.evaluate("(()=>{const b=document.createElement('button');b.dataset.sec='open';b.id='forced';b.textContent='x';b.style.cssText='position:fixed;top:60px;left:60px;z-index:200000';document.body.appendChild(b);b.click()})()")
    g.wait_for_timeout(500)
    check('G4: forcing the security panel open does nothing for a guest', g.evaluate("!document.querySelector('#overlay [data-sec-root]')"))
    g.evaluate("(()=>{const b=document.createElement('button');b.dataset.lg='open';b.id='forced2';document.body.appendChild(b);b.click()})()")
    g.wait_for_timeout(500)
    check('G4: forcing the add-entry screen open does nothing for a guest', g.evaluate("!document.querySelector('#overlay .drawer.lg')"))
    g.keyboard.press('n'); g.wait_for_timeout(500)
    check('G4: the "n" new-entry shortcut does nothing for a guest', g.evaluate("!document.querySelector('#overlay .drawer.lg')&&!document.querySelector('#overlay .overlay')"))
    check('G4: the greeting does not use the owner\'s name', 'Isaiah' not in (g.text_content('#ttl') or ''), g.text_content('#ttl') or '')
    check('G4: no guest-related page errors', not any(('Illegal' in e or 'mmGuest' in e or 'localStorage' in e) for e in g.errs), str(g.errs[:3]))
    check('G5: guest key lives only in this tab (the page sees it)', g.evaluate("localStorage.getItem('mm.lgSecret')") == gkey)
    g.screenshot(path='/tmp/claude-0/-home-claude/249fd8a4-4359-5a49-a217-2d0de786acef/scratchpad/guest-desktop.png')

    # the owner's saved sign-in in the same browser is untouched, and the guest key was never saved to the browser
    third = page_in(ctx); third.goto(PAGE.as_uri()); third.wait_for_timeout(800)
    check('G5: owner key still saved after the guest link was opened', third.evaluate("localStorage.getItem('mm.lgSecret')") == OWNER)
    check('G5: guest key was never written to saved storage', third.evaluate("JSON.stringify(Object.assign({},localStorage))") .find(gkey) < 0)
    check('G5: the original owner tab is still the owner (no banner, controls present)', owner.evaluate("!document.getElementById('guest-banner')") and not owner.evaluate("document.documentElement.classList.contains('mm-guest')"))
    check('G5: owner still sees the $ button', visible(owner, '[data-sec]'))

    # mobile layout
    gm = ctx.new_page(); gm.set_viewport_size({'width': 390, 'height': 844}); gm.goto(PAGE.as_uri() + link_for(gkey, gexp)); gm.wait_for_timeout(2000)
    check('G6: mobile: banner visible and nothing owner-only shows', visible(gm, '#guest-banner') and not visible(gm, '[data-sec]') and not visible(gm, '.lg-fab'))
    gm.screenshot(path='/tmp/claude-0/-home-claude/249fd8a4-4359-5a49-a217-2d0de786acef/scratchpad/guest-mobile.png')
    ctx.close()

    # ---------- ended links ----------
    def ended(name, frag, expect, need_net=None):
        f = Fake(); c = new_ctx(b, f); pg = page_in(c)
        pg.goto(PAGE.as_uri() + frag); pg.wait_for_timeout(2500)
        txt = pg.text_content('#guest-ended') or ''
        check(f'{name}: shows "{expect}"', expect in txt, txt)
        check(f'{name}: no sign-in screen offered to the guest (overlay covers it)', pg.evaluate("(()=>{const o=document.getElementById('guest-ended');return !!o&&getComputedStyle(o).position==='fixed'})()"))
        check(f'{name}: no guest banner / no data loaded', not pg.evaluate("!!document.getElementById('guest-banner')") )
        if need_net is False: check(f'{name}: nothing was sent to the script', not [x for x in f.log if x.get('secret')], str(f.log))
        c.close(); return pg
    ended('E1 expired in the link', link_for(secrets.token_hex(32), int(time.time() * 1000) - 5000), 'This guest link has expired', False)
    ended('E2 revoked / unknown key', link_for(secrets.token_hex(32), int(time.time() * 1000) + 3600_000), 'This guest link has expired')
    ended('E3 malformed link', '#guest=oops', 'not valid', False)

    # a guest link that ends while the page is open
    f = Fake(); k = secrets.token_hex(32); e = int(time.time() * 1000) + 3600_000; f.guests[k] = {'exp': e, 'preset': 'all', 'id': k[:10]}
    c = new_ctx(b, f); pg = page_in(c); pg.goto(PAGE.as_uri() + link_for(k, e)); pg.wait_for_timeout(1500)
    check('E4: link works while live', visible(pg, '#guest-banner'))
    del f.guests[k]; pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    pg.evaluate("window.mmGuest.exp=Date.now()-1"); pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); pg.wait_for_timeout(2000)
    check('E4: when time is up the page switches to "This guest link has expired"', 'This guest link has expired' in (pg.text_content('#guest-ended') or ''))
    pg.evaluate("document.querySelector('#guest-ended button').click()"); pg.wait_for_timeout(1500)
    check('E4: the owner button goes to the normal sign-in screen', modal_open(pg))
    c.close()

    # ---------- owner side: Guest access card ----------
    fake = Fake(); ctx = new_ctx(b, fake); o = owner_page(ctx)
    o.click('[data-sec="open"]'); o.wait_for_timeout(1200)
    check('C0: the card starts folded like the other settings cards', o.evaluate("document.getElementById('gst-card').classList.contains('mm-sc-closed')"))
    check('C0: merely opening settings sends no guest request', not [x for x in fake.log if str(x.get('action','')).startswith('guest_')], str(fake.log))
    o.click('#gst-card .m3-card-head'); o.wait_for_timeout(400)
    check('C1: the Guest access card is in Security & Settings', o.evaluate("!!document.getElementById('gst-card')") and 'Guest access' in (o.text_content('#gst-card') or ''))
    durs = o.evaluate("[...document.querySelectorAll('#gst-dur option')].map(o=>Number(o.value))")
    check('C1: durations are exactly 30 min, 1 h, 6 h, 12 h, 24 h, 48 h, 7 d', durs == [30, 60, 360, 720, 1440, 2880, 10080], str(durs))
    vis = o.evaluate("[...document.querySelectorAll('#gst-vis option')].map(o=>o.value)")
    check('C1: visibility choices are the three presets', sorted(vis) == ['all', 'business', 'sales'], str(vis))
    check('C1: nothing is listed yet', 'No active guest links' in (o.text_content('#gst-list') or ''), o.text_content('#gst-list') or '')
    o.select_option('#gst-dur', '360'); o.select_option('#gst-vis', 'business')
    o.click('[data-guest="create"]'); o.wait_for_timeout(1500)
    made = [x for x in fake.log if x.get('action') == 'guest_create']
    check('C2: create sends the chosen duration and visibility with the owner key', made and made[-1]['minutes'] == 360 and made[-1]['preset'] == 'business' and made[-1]['secret'] == OWNER, str(made))
    link = o.evaluate("(document.getElementById('gst-link')||{}).value||''")
    m = re.search(r'#guest=' + SID + r'~([0-9a-f]{64})~(\d{13})$', link)
    check('C2: a link in the right format is shown', bool(m), link)
    check('C2: copy button is there', o.evaluate("!!document.querySelector('[data-guest=\"copy\"]')"))
    check('C2: it appears in the active list', 'Business only' in (o.text_content('#gst-list') or ''), o.text_content('#gst-list') or '')
    check('C2: the secret key is not shown anywhere in the list', m and m.group(1) not in (o.text_content('#gst-list') or ''))
    frag = '#' + link.split('#', 1)[1]
    rt = page_in(ctx); rt.goto(PAGE.as_uri() + frag); rt.wait_for_timeout(2000)
    check('C3: the link the owner made opens a working guest view', visible(rt, '#guest-banner') and not modal_open(rt))
    o.click('[data-guest="create"]'); o.wait_for_timeout(1200)
    o.click('[data-guest="revoke"]'); o.wait_for_timeout(1200)
    check('C4: "End now" sends a revoke for that one link', any(x.get('action') == 'guest_revoke' and x.get('id') for x in fake.log))
    o.once('dialog', lambda d: d.accept())
    o.click('[data-guest="revokeall"]'); o.wait_for_timeout(1200)
    check('C4: "End all" revokes everything', any(x.get('action') == 'guest_revoke' and x.get('all') is True for x in fake.log) and not fake.guests)
    check('C4: list is empty afterwards', 'No active guest links' in (o.text_content('#gst-list') or ''))
    check('C5: no page errors on the owner side', not [e for e in o.errs if 'gst' in e or 'guest' in e.lower()], str(o.errs[:3]))
    ctx.close()
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
if fails: print('FAILED:', fails); raise SystemExit(1)

# Run with: python3 tests/ui-investment-banner.py        (needs: pip install playwright && playwright install chromium)
# Checks, in a real browser, that the weekly investment reminder shows inside the expiry banner (yellow, even with no deposits or loans),
# that the old stand-alone card is never shown at the same time, that Dismiss lasts for the week, and that turning the option or the banner off
# gives the old card back, so nothing is lost. Older saved settings still work. Never touches Google or the sheet.
import pathlib, json
from playwright.sync_api import sync_playwright
PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
INIT_CHART = "window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"
fails=[]
def check(n,c,x=''):
    print(('ok - ' if c else 'FAIL - ')+n, '' if c else x)
    if not c: fails.append(n)
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':1100,'height':800}); page=ctx.new_page()
    errs=[]; page.on('pageerror',lambda e:errs.append(str(e)))
    reqs=[]; page.on('request',lambda r: reqs.append(r.url) if ('script.google.com' in r.url or 'googleusercontent' in r.url) else None)
    # reminder ON, due now (today, 00:00); expiry banner default settings; NO owed items
    page.add_init_script(INIT_AUTH); page.add_init_script(INIT_CHART)
    page.add_init_script("localStorage.setItem('mm.notif',JSON.stringify({enabled:true,day:new Date().getDay(),time:'00:00'}));")
    page.goto(PAGE.as_uri()+'?demo=1'); page.wait_for_function(READY)
    page.evaluate("window.__mmExpiryCheck(); window.__mmNotifApi.check()")
    page.wait_for_timeout(600)
    eb=page.locator('#expiry-banner')
    check('banner shows with no deposits/loans when the weekly reminder is due', eb.count()==1)
    txt=eb.inner_text() if eb.count() else ''
    check('shows investment reminder text', 'Investment reminder' in txt and 'investment contribution' in txt, txt)
    check('uses the yellow open look', 'eb-pending' in (page.locator('#expiry-banner .eb-card').get_attribute('class') or ''))
    check('old stand-alone card is NOT shown at the same time', page.locator('#notif-banner').count()==0)
    check('live region speaks the reminder', 'investment' in page.locator('#eb-live').text_content().lower(), page.locator('#eb-live').text_content())
    # Dismiss -> gone, remembered for the week, old card does not take over
    page.locator('[data-eb="dismiss"]').click(); page.wait_for_timeout(400)
    check('dismiss removes it', page.locator('#expiry-banner').count()==0)
    check('dismiss uses the weekly memory', bool(page.evaluate("localStorage.getItem('mm.notif.dismissed')")))
    check('old card stays hidden after dismiss', page.locator('#notif-banner').count()==0)
    # Fallback: option off + not dismissed -> old card returns, banner gone
    page.evaluate("localStorage.removeItem('mm.notif.dismissed'); localStorage.setItem('mm.expiry',JSON.stringify({invest:false})); window.__mmExpiryCheck(); window.__mmNotifApi.check()")
    page.wait_for_timeout(500)
    check('option off: banner gone', page.locator('#expiry-banner').count()==0)
    check('option off: old reminder card comes back (nothing lost)', page.locator('#notif-banner').count()==1)
    # Banner fully off -> old card still works
    page.evaluate("localStorage.setItem('mm.expiry',JSON.stringify({enabled:false,invest:true})); window.__mmExpiryCheck(); window.__mmNotifApi.check()")
    page.wait_for_timeout(500)
    check('banner off: old card still shown', page.locator('#notif-banner').count()==1 and page.locator('#expiry-banner').count()==0)
    # Back on via the settings switch
    page.evaluate("localStorage.removeItem('mm.expiry'); window.__mmExpiryCheck(); window.__mmNotifApi.check()"); page.wait_for_timeout(500)
    check('defaults restored: banner shows it, old card hidden', page.locator('#expiry-banner').count()==1 and page.locator('#notif-banner').count()==0)
    # Old saved config without invest field still works
    page.evaluate("localStorage.setItem('mm.expiry',JSON.stringify({enabled:true,position:'top',size:'small',depDays:3,loanDays:3,speed:6,pause:true})); window.__mmExpiryCheck()"); page.wait_for_timeout(400)
    check('older saved settings (no invest value) still show it', page.locator('#expiry-banner.eb-top').count()==1)
    # Settings switch exists and round-trips
    html=page.evaluate("window.__mmExpirySettingsHtml()")
    check('settings switch rendered', 'id="eb-inv"' in html and 'checked' in html.split('id="eb-inv"')[1][:30])
    check('nothing sent to the sheet', not reqs, reqs[:3]); check('no page errors from the banner code', not [e for e in errs if 'tailwind' not in e], errs[:3])
    b.close()
print(len(fails),'failed' if fails else 'all passed', fails)
raise SystemExit(1 if fails else 0)

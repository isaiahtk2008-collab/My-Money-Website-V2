# Run with: python3 tests/ui-settings-m3.py        (needs: pip install playwright && playwright install chromium)
# Opens the real Security & Settings panel in Chromium and checks the Material 3 card layout, that every control the rest of
# the app depends on is still present exactly once, the reminder defaults (Thursday, 5:00 PM) and the auth error text.
# Never touches Google. (Checks drafted by local Ollama, reviewed and wired up by Claude.)
import pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

def run(p):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 800})
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)   # Tailwind CDN is blocked in the test
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())   # block everything else (CDNs, Google)
    page.add_init_script("try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}")
    page.add_init_script("window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};")
    page.goto(PAGE.as_uri())
    page.wait_for_function("typeof store!=='undefined' && store.D && store.D.expenses.length>3")
    return b, page, errors

with sync_playwright() as p:
    b, page, errors = run(p)
    page.click('.logo[data-sec=open]')
    page.wait_for_selector('.m3-scope')
    check('Card count', page.locator('.m3-card').count() == 6)
    check('Card titles', page.locator('.m3-card-title').all_inner_texts() == ['Google Account Connection', 'Local Security', 'In-App Reminders', 'Status colours on the Log menu', 'Appearance', 'Sheet Sync Connection'])
    check('Border radius', page.evaluate("getComputedStyle(document.querySelector('.m3-card')).borderRadius") == '16px')
    selectors = ['[data-sec=signout]', '#sec-u', '#sec-n1', '#sec-n2', '[data-sec=save]', '#notif-on', '#notif-day', '#notif-time', '[data-notif=test]', '[data-sec=sheet]', '[data-sec-root]']
    for selector in selectors:
        check(f'Selector {selector}', page.locator(selector).count() == 1)
    check('Notification day defaults to Thursday', page.input_value('#notif-day') == '4')
    check('Notification time defaults to 5:00 PM', page.input_value('#notif-time') == '17:00')
    page.click('[data-notif=test]')
    check('Preview shows banner', page.locator('#notif-banner').count() == 1)
    page.click('[data-notif=dismiss]')
    check('Dismiss hides banner', page.locator('#notif-banner').count() == 0)
    check('Reminder toggle id is unique', page.evaluate("document.querySelectorAll('[id=notif-on]').length") == 1)
    check('Auth error text present', 'Access Restricted: Authentication Failed' in page.content())
    check('Sheet chip says Not connected without a link', 'Not connected' in page.locator('.m3-chip').inner_text())
    page.evaluate("LS.set('lgUrl','https://script.example/exec')")
    page.evaluate("window.__mmShowSettings()")   # re-renders the open panel
    check('Sheet chip says Connected with a link', 'Connected' == page.locator('.m3-chip').inner_text().strip())
    check('No JS errors', errors == [], extra=str(errors))
    b.close()
    print(f'{passed} passed, {len(fails)} failed')
    sys.exit(1 if fails else 0)

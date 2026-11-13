# Run with: python3 tests/ui-expiry-settings.py        (needs: pip install playwright && playwright install chromium)
# Checks the "Expiry banner" card under Settings > In-App in a real browser: every control is there once, changes are saved on this device only (mm.expiry),
# bad numbers are cleaned, the banner follows the settings, Preview works with no real data and saves nothing, Reset restores the defaults but keeps snoozes,
# the phone layout does not overflow, and nothing is sent anywhere. Never touches Google or the sheet.
import pathlib, json
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
INIT_FOLD = "try{localStorage.setItem('mm.setfold',JSON.stringify(['Google Account Connection','Local Security','In-App Reminders','Expiry banner','Status colours on the Log menu','Appearance','Minimize / maximize buttons','Sheet Sync Connection']))}catch(e){}"
INIT_CHART = "window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"
CFG = "JSON.parse(localStorage.getItem('mm.expiry')||'null')"

def open_settings(page):
    page.click('.logo[data-sec=open]'); page.wait_for_selector('#eb-card')

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 800})
    page = ctx.new_page()
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    def route(r):
        if r.request.url.startswith('file:'): r.continue_()
        else:
            requests.append((r.request.method, r.request.url)); r.abort()
    page.route('**/*', route)
    for s in (INIT_AUTH, INIT_FOLD, INIT_CHART): page.add_init_script(s)
    page.goto(PAGE.as_uri() + '?demo=1'); page.wait_for_function(READY)
    open_settings(page)

    for sel in ['#eb-on', '#eb-pos', '#eb-size', '#eb-dep', '#eb-loan', '#eb-speed', '#eb-pause', '[data-ebs=preview]', '[data-ebs=reset]']:
        check('control ' + sel + ' appears once', page.locator(sel).count() == 1)
    titles = page.locator('.m3-card-title').all_inner_texts()
    check('card sits right after In-App Reminders', titles.index('Expiry banner') == titles.index('In-App Reminders') + 1, titles)
    check('defaults are shown', page.is_checked('#eb-on') and page.input_value('#eb-size') == 'medium' and page.input_value('#eb-dep') == '3' and page.input_value('#eb-loan') == '3' and page.input_value('#eb-speed') == '6' and page.is_checked('#eb-pause'))
    check('other positions are listed but not selectable yet', page.evaluate("[...document.querySelectorAll('#eb-pos option')].filter(o=>o.disabled).length") == 3)
    check('nothing is saved until something is changed', page.evaluate(CFG) is None)

    # saving and cleaning
    page.select_option('#eb-size', 'large')
    check('size change is saved on this device', page.evaluate(CFG)['size'] == 'large')
    page.fill('#eb-dep', '99'); page.dispatch_event('#eb-dep', 'change')
    check('99 days is cleaned to 60, in the box and in storage', page.input_value('#eb-dep') == '60' and page.evaluate(CFG)['depDays'] == 60)
    page.fill('#eb-loan', ''); page.dispatch_event('#eb-loan', 'change')
    check('an empty days box falls back to 3', page.input_value('#eb-loan') == '3' and page.evaluate(CFG)['loanDays'] == 3)
    page.fill('#eb-dep', '0'); page.dispatch_event('#eb-dep', 'change')
    check('0 days is allowed', page.evaluate(CFG)['depDays'] == 0)
    page.evaluate("(()=>{const e=document.getElementById('eb-speed');e.value='12';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
    check('speed label and storage follow the slider', '12 seconds' in page.inner_text('#eb-speed-v') and page.evaluate(CFG)['speed'] == 12)
    page.uncheck('#eb-pause')
    check('pause switch is saved', page.evaluate(CFG)['pause'] is False)
    page.uncheck('#eb-on')
    check('on/off switch is saved', page.evaluate(CFG)['enabled'] is False)

    # preview works even while the banner is switched off and there is no real data
    check('no banner while off', page.locator('#expiry-banner').count() == 0)
    page.click('[data-ebs=preview]')
    check('Preview shows the banner with made-up items', page.locator('#expiry-banner').count() == 1 and 'Sample' in page.inner_text('#expiry-banner'))
    check('Preview follows the chosen size', 'eb-s-large' in (page.get_attribute('#expiry-banner', 'class') or ''))
    check('Preview shows the overdue one first with the blinking red style', 'eb-overdue' in (page.get_attribute('#expiry-banner .eb-card', 'class') or '') and '1 of 2' in page.inner_text('#expiry-banner'))
    snooze_before = page.evaluate("localStorage.getItem('mm.expiry.snooze')")
    page.click('#expiry-banner [data-eb=dismiss]')
    check('closing the preview removes it and saves no snooze', page.locator('#expiry-banner').count() == 0 and page.evaluate("localStorage.getItem('mm.expiry.snooze')") == snooze_before)
    check('the off setting is still off after a preview', page.evaluate(CFG)['enabled'] is False and not page.is_checked('#eb-on'))

    # reset keeps snoozes
    page.evaluate("localStorage.setItem('mm.expiry.snooze', JSON.stringify({'dep:keep':'2999-01-01'}))")
    page.click('[data-ebs=reset]')
    check('Reset restores every default in the form', page.is_checked('#eb-on') and page.input_value('#eb-size') == 'medium' and page.input_value('#eb-dep') == '3' and page.input_value('#eb-loan') == '3' and page.input_value('#eb-speed') == '6' and page.is_checked('#eb-pause') and '6 seconds' in page.inner_text('#eb-speed-v'))
    check('Reset clears the saved settings', page.evaluate("localStorage.getItem('mm.expiry')") is None)
    check('Reset keeps snoozes', 'dep:keep' in (page.evaluate("localStorage.getItem('mm.expiry.snooze')") or ''))

    # the settings survive a reload
    page.select_option('#eb-size', 'small')
    page.reload(); page.wait_for_function(READY); open_settings(page)
    check('settings are still there after a reload', page.input_value('#eb-size') == 'small')

    # phone width: the card fits and the controls are reachable
    page.set_viewport_size({'width': 375, 'height': 760}); page.wait_for_timeout(200)
    box = page.locator('#eb-card').bounding_box()
    check('card fits the phone width (no sideways overflow)', box['x'] >= 0 and box['x'] + box['width'] <= 376 and page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), box)
    check('all controls fit inside the card on a phone', page.evaluate("""(()=>{const c=document.getElementById('eb-card').getBoundingClientRect();return [...document.querySelectorAll('#eb-card input,#eb-card select,#eb-card button')].every(e=>{const r=e.getBoundingClientRect();return r.left>=c.left-1&&r.right<=c.right+1})})()"""))

    check('no page errors', not errors, errors)
    check('nothing was sent anywhere (only the page\'s own library downloads were tried, and blocked)', not [r for r in requests if r[0] != 'GET'], str(requests))
    b.close()

print(f'{passed} passed, {len(fails)} failed')
raise SystemExit(1 if fails else 0)

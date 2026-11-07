# Run with: python3 tests/ui-appearance-v4.py        (needs: pip install playwright && playwright install chromium)
# Checks the Appearance changes: Glow strength lives inside Fine tuning (and still works), Hover enlarge goes up to 500%,
# the new Background option (presets, custom colour, reset, device-only, bad values ignored), and a hovered card rising above its neighbour.
# Never touches Google or the sheet.
import pathlib, sys
from playwright.sync_api import sync_playwright

PAGE = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
fails, passed = [], 0

def check(name, cond, extra=''):
    global passed
    if cond: passed += 1; print('ok -', name)
    else: fails.append(name); print('FAIL -', name, extra)

INIT_AUTH = "try{sessionStorage.setItem('user_authenticated','true');sessionStorage.setItem('mm.auth.method','local')}catch(e){}"
INIT_AUTH += "try{localStorage.setItem('mm.ap.drawer3','1')}catch(e){}"
INIT_AUTH += "try{localStorage.setItem('mm.setfold',JSON.stringify(['Google Account Connection','Local Security','In-App Reminders','Status colours on the Log menu','Appearance','Minimize / maximize buttons','Sheet Sync Connection']))}catch(e){}"
INIT_CHART = "window.Chart=function(){return{destroy(){},update(){},resize(){}}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{labels:{}}}};"
READY = "typeof store!=='undefined' && store.D && store.D.expenses.length>3"

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 1100, 'height': 800}).new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)) if 'tailwind is not defined' not in str(e) else None)
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'tailwind is not defined' not in m.text else None)
    page.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script(INIT_AUTH); page.add_init_script(INIT_CHART)
    page.goto(PAGE.as_uri()); page.wait_for_function(READY)
    page.click('.logo[data-sec=open]'); page.wait_for_selector('#hfx-card')

    # ---- glow slider moved into Fine tuning ----
    check('Glow strength slider is inside the Fine tuning drawer', page.locator('#ap3-drawer #hfx-s').count() == 1)
    check('Glow strength appears only once', page.locator('#hfx-s').count() == 1 and page.locator('#hfx-sv').count() == 1)
    check('Glow strength is the first row of Fine tuning', page.evaluate("document.querySelector('#ap3-drawer .hfx-drawer-body').firstElementChild.querySelector('#hfx-s')!==null"))
    check('Glow direction chips still in the card', page.locator('#hfx-card [data-hfx-dir]').count() == 5)
    page.evaluate("()=>{const s=document.querySelector('#hfx-s');s.value=40;s.dispatchEvent(new Event('input',{bubbles:true}))}")
    check('Glow slider still drives the glow strength', page.evaluate("document.documentElement.style.getPropertyValue('--hfx-s').trim()") == '40')

    # ---- hover enlarge up to 500% ----
    check('Hover enlarge slider max is 500', page.locator('#ap3-enl').get_attribute('max') == '500')
    page.evaluate("()=>{const s=document.querySelector('#ap3-enl');s.value=500;s.dispatchEvent(new Event('input',{bubbles:true}))}")
    check('500% reads 500%', page.locator('#ap3-enl-v').inner_text() == '500%')
    check('500% applies the multiplier 5', page.evaluate("document.documentElement.style.getPropertyValue('--ap3-enl').trim()") == '5.000')
    check('500% is saved', page.evaluate("localStorage.getItem('mm.hfx.enl')") == '500')

    # ---- background ----
    check('Background section exists with presets', page.locator('#hfx-card [data-ap3-bgc]').count() >= 12)
    default_bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    page.click('#hfx-card [data-ap3-bgc="#0b1220"]')
    check('Preset sets the page background variable', page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()") == '#0b1220')
    check('Preset is saved on this device', page.evaluate("localStorage.getItem('mm.hfx.bgc')") == '#0b1220')
    check('Preset chip shows pressed', page.locator('#hfx-card [data-ap3-bgc="#0b1220"]').get_attribute('aria-pressed') == 'true')
    page.evaluate("()=>{const i=document.querySelector('#ap3-bgcustom');i.value='#223344';i.dispatchEvent(new Event('input',{bubbles:true}))}")
    check('Custom colour applies', page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()") == '#223344')
    check('Custom colour is saved', page.evaluate("localStorage.getItem('mm.hfx.bgc')") == '#223344')
    page.evaluate("()=>localStorage.setItem('mm.hfx.bgc','javascript:alert(1)')"); page.reload(); page.wait_for_function(READY)
    check('A bad saved value is ignored', page.evaluate("document.documentElement.hasAttribute('data-ap3-bgc')") is False)
    page.evaluate("()=>localStorage.setItem('mm.hfx.bgc','#102030')"); page.reload(); page.wait_for_function(READY)
    check('A saved colour survives a reload', page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()") == '#102030')
    check('Background is not part of the sheet sync list', page.evaluate("document.documentElement.innerHTML.indexOf(\"'mm.hfx.bgc'\")") >= 0 and page.evaluate("(()=>{try{return JSON.stringify(window.__mmSyncKeys||[]).indexOf('mm.hfx.bgc')}catch(e){return -1}})()") <= 0)
    page.click('.logo[data-sec=open]'); page.wait_for_selector('#hfx-card')
    page.click('#hfx-card [data-ap3-bgreset]')
    check('Reset background removes the override', page.evaluate("document.documentElement.hasAttribute('data-ap3-bgc')") is False and page.evaluate("localStorage.getItem('mm.hfx.bgc')") is None)
    page.click('#hfx-card [data-ap3-bgc="#f4f6fa"]')
    page.click('#hfx-card [data-hfx-reset]')
    check('Reset to default also clears the background', page.evaluate("localStorage.getItem('mm.hfx.bgc')") is None and page.evaluate("document.documentElement.hasAttribute('data-ap3-bgc')") is False)
    check('Reset to default brings back the original page colour', page.evaluate("getComputedStyle(document.body).backgroundColor") == default_bg)
    check('Panel has no sideways scrollbar', page.evaluate("(()=>{const d=document.querySelector('#overlay .drawer.lg');return d?d.scrollWidth-d.clientWidth:0})()") <= 0)

    # ---- stacking: a hovered card rises above the next one ----
    close = page.evaluate("document.querySelector('#overlay').innerHTML=''")
    page.wait_for_timeout(200)
    z = page.evaluate("""()=>{const cs=[...document.querySelectorAll('.card')].filter(c=>c.offsetParent);if(cs.length<2)return null;
        const c=cs[0];c.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));return cs.length}""")
    check('Page has several cards to test stacking on', z is not None and z >= 2)
    card = page.locator('div.card:visible, section.card:visible, article.card:visible').first
    card.hover(); page.wait_for_timeout(300)
    cs = card.evaluate("e=>{const s=getComputedStyle(e);return [s.position,s.zIndex]}")
    check('A hovered card is raised (position relative, z-index 12)', cs == ['relative', '12'], str(cs))
    check('The raise stays below the sticky header (z-index 40)', int(cs[1]) < 40)
    check('No JS errors', not errors, str(errors[:3]))
    b.close()

print(f'\n{passed} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)

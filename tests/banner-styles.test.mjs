import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const start = html.indexOf('/* ================= EXPIRY BANNER');
const end = html.indexOf("setTimeout(()=>flush(true),2500);");
const ui = html.slice(start, end);
const coreStart = html.indexOf('/* ===== EXPIRY BANNER CORE START ===== */');
const coreEnd = html.indexOf('/* ===== EXPIRY BANNER CORE END ===== */');
const core = html.slice(coreStart, coreEnd);

test('the saved banner config is unchanged: style is stored on its own, outside the core logic', () => {
  assert.ok(!/style/i.test(core.replace(/\/\*[\s\S]*?\*\//g, '')), 'core config and logic know nothing about styles');
  assert.ok(/const K_STY='mm\.expiry\.style'/.test(ui), 'own storage key');
  assert.ok(/EB_STYLES=\['card','bar','pill','minimal'\]/.test(ui), 'four styles, card first');
});

test('style loader falls back to the original card for anything unknown', () => {
  const m = ui.match(/function loadStyle\(\)\{[^\n]*\}/);
  assert.ok(m, 'loadStyle exists');
  const run = v => {
    const localStorage = { getItem: () => v };
    return new Function('localStorage', 'EB_STYLES', 'K_STY', m[0] + '; return loadStyle();')(localStorage, ['card', 'bar', 'pill', 'minimal'], 'mm.expiry.style');
  };
  for (const s of ['card', 'bar', 'pill', 'minimal']) assert.equal(run(s), s);
  for (const bad of [null, undefined, '', 'BAR', 'banner', '{"x":1}', 'constructor', '__proto__']) assert.equal(run(bad), 'card', String(bad));
  const throwing = new Function('localStorage', 'EB_STYLES', 'K_STY', m[0] + '; return loadStyle();');
  assert.equal(throwing({ getItem() { throw new Error('blocked'); } }, ['card', 'bar', 'pill', 'minimal'], 'mm.expiry.style'), 'card');
});

test('every look uses the same card markup and the same buttons, so snooze, dismiss, rotation and preview behave identically', () => {
  assert.equal((ui.match(/function paint\(/g) || []).length, 1, 'one paint function for all looks');
  assert.equal((ui.match(/class="eb-b" data-eb="snooze"/g) || []).length, 1, 'one Snooze button');
  assert.equal((ui.match(/class="eb-b" data-eb="dismiss"/g) || []).length, 1, 'one Dismiss button');
  const paintFn = ui.slice(ui.indexOf('function paint('), ui.indexOf('function show('));
  assert.ok(!/loadStyle|eb-st-/.test(paintFn), 'paint does not depend on the style');
  const schedule = ui.slice(ui.indexOf('function schedule()'), ui.indexOf('function previewing()'));
  assert.ok(!/loadStyle/.test(schedule), 'rotation does not depend on the style');
  const click = ui.slice(ui.indexOf("if(previewing()){endPreview()"), ui.indexOf("/* ----- Settings card"));
  assert.ok(!/loadStyle/.test(click), 'snooze/dismiss do not depend on the style');
});

test('check() applies the style class; the top bar is forced to the top; the style is part of the redraw signature', () => {
  assert.ok(/const st=loadStyle\(\), pos=st==='bar'\?'top':c\.position;/.test(ui));
  assert.ok(/b\.className='eb eb-'\+pos\+' eb-s-'\+c\.size\+' eb-st-'\+st\+\(pv\?' eb-pv':''\);/.test(ui));
  assert.ok(/\+c\.position\+'\|'\+st;/.test(ui), 'switching style redraws right away');
});

test('CSS: card has no rules (original look untouched); every new rule is scoped to its own style', () => {
  assert.ok(!/\.eb-st-card/.test(ui), 'no rules for the original card look');
  const cssStart = ui.indexOf("'.eb.eb-st-bar,.eb.eb-st-bar.eb-pv{");
  const cssEnd = ui.indexOf("document.head.appendChild(s)");
  const block = ui.slice(cssStart, cssEnd);
  for (const name of ['bar', 'pill', 'minimal']) assert.ok(block.includes('.eb.eb-st-' + name), name + ' has rules');
  const sels = block.match(/(?:^|[}'+])\s*'?([^{}'+@][^{}]*)\{/g) || [];
  assert.ok(sels.length > 5);
  assert.ok(!/\.eb-card\.eb-out/.test(block), 'the fade-out between items is not overridden');
  assert.ok(!/animation\s*:/.test(block), 'no look changes the overdue blink: all keep the original animation');
  assert.ok(/prefers-reduced-motion:reduce\)\{[^\n]*\.eb-overdue\{animation:none !important\}\}/.test(ui), 'reduced motion still stops the blink');
});

test('settings: style picker has four options, saves only mm.expiry.style, and reset returns to the card look', () => {
  assert.equal(ui.split('id="eb-style"').length - 1, 1, 'picker appears once');
  for (const v of ['card', 'bar', 'pill', 'minimal']) assert.ok(new RegExp('<option value="' + v + '"').test(ui.slice(ui.indexOf('id="eb-style"'))), v + ' option');
  const handler = ui.slice(ui.indexOf("t.id!=='eb-style'"), ui.indexOf("const FIELD") > 0 ? ui.indexOf("document.addEventListener('change',e=>{try{\n  const t=e.target; if(!t||!t.id||!Object.prototype.hasOwnProperty.call(FIELD") : undefined);
  assert.ok(/localStorage\.setItem\(K_STY,v\)/.test(handler), 'saves the style');
  assert.ok(!/K_CFG|K_SN|saveSn|Sheet|fetch\(/.test(handler), 'picker never touches settings, snoozes, the sheet or the network');
  assert.ok(/previewUntil=Date\.now\(\)\+20000/.test(handler), 'shows a preview of the new look');
  const reset = ui.slice(ui.indexOf("t.dataset.ebs==='reset'"), ui.indexOf("t.dataset.ebs==='preview'"));
  assert.ok(/removeItem\(K_STY\)/.test(reset) && !/K_SN/.test(reset), 'reset restores the card look and still keeps snoozes');
});

test('nothing outside the banner changed: no sheet, network or script code in the new parts', () => {
  const added = ui.slice(ui.indexOf('const K_STY'), ui.indexOf('let idx=0,'));
  assert.ok(!/fetch|sheetCall|XMLHttpRequest|APPS_SCRIPT/.test(added));
});

test('top bar is pinned to the very top of the window and the page is pushed down by its measured height', () => {
  assert.ok(/'\.eb\.eb-st-bar,\.eb\.eb-st-bar\.eb-pv\{top:0;left:0;right:0;bottom:auto;z-index:99980\}'/.test(ui), 'full width from the very top, above everything (also during a preview)');
  assert.ok(/html\.mm-guest \.eb\.eb-st-bar\{top:calc\(34px/.test(ui), 'sits just under the guest-link bar when both show');
  assert.ok(/html\.mm-eb-bar body\{padding-top:var\(--eb-off\)\}/.test(ui), 'page content starts below the bar');
  assert.ok(/html\.mm-eb-bar \.top\{top:calc\(var\(--eb-off\)/.test(ui), 'sticky header starts below the bar');
  assert.ok(/html\.mm-eb-bar \.overlay\{top:var\(--eb-off\)\}/.test(ui), 'settings panel and pop-ups start below the bar, so their close buttons stay reachable');
  assert.ok(/@media \(min-width:721px\)\{html\.mm-eb-bar \.rail\{top:var\(--eb-off\);height:calc\(100vh - var\(--eb-off\)\)\}\}/.test(ui), 'side rail starts below the bar on desktop only; the phone dock is untouched');
  assert.ok(/html\.mm-guest\.mm-eb-bar\{--eb-off:calc\(34px/.test(ui), 'guest bar plus banner bar add up');
});

test('the page offset is only on while the top bar shows, and is always cleared when it goes away', () => {
  const gone = ui.match(/function gone\(b\)\{[^\n]*\}/)[0];
  assert.ok(/barSpace\(false\)/.test(gone), 'banner removed -> offset removed');
  assert.ok(/barSpace\(st==='bar'\);/.test(ui), 'every redraw sets it on for the bar and off for every other look');
  const fn = ui.slice(ui.indexOf('function barSpace('), ui.indexOf('let idx=0'));
  assert.ok(/classList\.remove\('mm-eb-bar'\)/.test(fn) && /removeProperty\('--eb-bar-h'\)/.test(fn), 'off removes the class and the height');
  assert.ok(/ResizeObserver/.test(fn) && /disconnect\(\)/.test(fn), 'follows height changes and cleans up');
  assert.ok(/try\{/.test(fn) && /catch\(e\)\{\}/.test(fn), 'can never throw into the page');
});

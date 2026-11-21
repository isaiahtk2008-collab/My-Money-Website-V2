// Run with: node --test tests/phone-accessory-chips.test.mjs
// Loads the REAL scExtraBuild / scAccType / scAccConnHist / scNormalizeBuild out of index.html (fake data only) and proves, for the Bought phone and Bought accessory scan flow:
//  - a power adapter label offers TAP CHIPS only (phone: Charger / Original Box / Case; accessory: Included Accessories), nothing is ever filled in
//  - Connection Type is offered from past entries of the same model (2+ rows, 60%), else common guesses for the item type; Item Type from the model name; Color never
//  - answered fields get no chip; the Bought PC path and unknown forms are untouched; every feature flag turns its chip off
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html0 = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
function load(mut = s => s) {
  const html = mut(html0);
  const constLine = name => { const m = html.match(new RegExp('^const ' + name + '=.*$', 'm')); if (!m) throw new Error(name + ' not found'); return m[0]; };
  const fnBlock = name => {
    const start = html.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    let i = html.indexOf('{', html.indexOf(')', start)), d = 0;
    for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (d === 0) return html.slice(start, i + 1); } }
    throw new Error('unbalanced ' + name);
  };
  const fld = (k, extra = {}) => Object.assign({ k, l: k, t: 'text', o: [] }, extra);
  const BY = {
    bphone: { f: ['Serial Number', 'Phone Model', 'Original Box', 'Charger', 'Case'].map(k => fld(k, /Box|Charger|Case/.test(k) ? { t: 'yn' } : {})) },
    bacc: { f: [
      fld('Item Type', { t: 'radio', o: ['Monitor', 'Mouse', 'Controller', 'Keyboard', 'Headphones', 'Earbuds', 'Watch'] }), fld('Model'), fld('Color'),
      fld('Connection Type', { t: 'multi', ex: ['N/A'], o: ['Wired USB-A', 'Wired USB-C', 'Wireless 2.4GHz', 'Bluetooth', '3.5mm Audio', 'HDMI/DisplayPort', 'N/A'] }),
      fld('Included Accessories', { t: 'multi', ex: ['None'], o: ['Charger/power adapter', 'Stand/mount', 'Case/pouch', 'Manual/box', 'None'] })] },
    bpc: { f: ['PC model', 'Original Charger'].map(k => fld(k)) }
  };
  const ctx = vm.createContext({ BY, unsold: () => [], V: {} });
  vm.runInContext([
    constLine('scTxt'), fnBlock('scHas'),
    constLine('SC_EXTRA_ON'), constLine('SC_ACC_TYPE_RES'), constLine('SC_ACC_CONN_GUESS'), fnBlock('scAccType'), fnBlock('scAccConnHist'), fnBlock('scExtraBuild'),
    'const SC_ASSUME_ON=false,SC_CHARGER_LABEL_ON=false,HX_SIMILAR_ON=false,scChargerChip=()=>{};',
    fnBlock('scNormalizeBuild'),
    'globalThis.__t={scAccType,scAccConnHist,scExtraBuild,scNormalizeBuild};'
  ].join('\n'), ctx);
  return ctx.__t;
}
const T = load();
const J = x => JSON.parse(JSON.stringify(x));   // cross-realm objects: compare as plain JSON
const keys = o => Object.keys(o).sort();
const NOTE = { notes: [{ kind: 'charger', text: 'Charger label: 5V 2A', image: 2 }] };
const build = V => ({ V, filled: Object.keys(V).map(k => ({ k, val: String(V[k]), conf: 'high', ev: '', img: 0, crop: null })), fix: {} });
const rowsOf = (model, conns) => ({ BoughtAccess: { rows: conns.map(c => ({ Model: model, 'Connection Type': c })) } });

test('phone: a charger label offers Yes chips for Charger, Original Box and Case and fills nothing', () => {
  const b = build({ 'Phone Model': 'Pixel 7' }), before = J(b);
  const o = T.scNormalizeBuild(b, 'bphone', NOTE);
  assert.deepEqual(keys(o.fix), ['Case', 'Charger', 'Original Box']);
  assert.deepEqual(J(o.fix.Charger.vals), ['Yes']);
  assert.deepEqual(J(o.V), before.V, 'no value filled');
  assert.deepEqual(J(b), before, 'input not mutated');
});
test('phone: answered fields get no chip; no label = the very same object back', () => {
  const o = T.scNormalizeBuild(build({ Charger: 'Yes', 'Original Box': 'No' }), 'bphone', NOTE);
  assert.deepEqual(keys(o.fix), ['Case']);
  const b = build({ 'Phone Model': 'Pixel 7' });
  assert.equal(T.scNormalizeBuild(b, 'bphone', { notes: [] }), b);
  assert.equal(T.scNormalizeBuild(b, 'bphone', undefined), b);
});
test('accessory: label offers a multi chip for Included Accessories, skipped when already there or None', () => {
  let o = T.scNormalizeBuild(build({ Model: 'MX Master 3' }), 'bacc', NOTE);
  assert.deepEqual(J(o.fix['Included Accessories'].vals), ['Charger/power adapter']);
  assert.equal(o.fix['Included Accessories'].multi, true);
  assert.equal(o.V['Included Accessories'], undefined, 'never filled');
  o = T.scNormalizeBuild(build({ 'Included Accessories': ['Case/pouch'] }), 'bacc', NOTE);
  assert.ok(o.fix['Included Accessories'], 'still offered next to other picks');
  o = T.scNormalizeBuild(build({ 'Included Accessories': ['Charger/power adapter'] }), 'bacc', NOTE);
  assert.equal(o.fix['Included Accessories'], undefined);
  o = T.scNormalizeBuild(build({ 'Included Accessories': ['None'] }), 'bacc', NOTE);
  assert.equal(o.fix['Included Accessories'], undefined);
});
test('accessory: Connection Type from history needs 2+ rows and 60% agreement', () => {
  const opts = ['Wired USB-A', 'Bluetooth', 'N/A'];
  assert.equal(T.scAccConnHist('Logi M720', rowsOf('Logi M720', ['Bluetooth, Wired USB-A', 'Wired USB-A, Bluetooth', 'Bluetooth']), opts).val, 'Bluetooth, Wired USB-A');
  assert.equal(T.scAccConnHist('Logi M720', rowsOf('Logi M720', ['Bluetooth']), opts), null, 'one row');
  assert.equal(T.scAccConnHist('Logi M720', rowsOf('Logi M720', ['Bluetooth', 'Wired USB-A']), opts), null, 'no majority');
  assert.equal(T.scAccConnHist('Logi M720', rowsOf('Other', ['Bluetooth', 'Bluetooth']), opts), null, 'other model');
  assert.equal(T.scAccConnHist('Logi M720', rowsOf('logi-m720', ['Bluetooth', 'Bluetooth']), opts).val, 'Bluetooth', 'case / punctuation tolerant');
});
test('accessory: history chip, else item-type guesses, never auto-filled, Color untouched', () => {
  const raw = rowsOf('Logi M720', ['Bluetooth', 'Bluetooth', 'Wired USB-A']);
  let o = T.scNormalizeBuild(build({ Model: 'Logi M720 mouse' }), 'bacc', {}, raw);
  assert.ok(o.fix['Connection Type'], 'name differs from history rows: item-type guess');
  assert.deepEqual(J(o.fix['Connection Type'].vals), ['Wired USB-A', 'Wireless 2.4GHz', 'Bluetooth']);
  o = T.scNormalizeBuild(build({ Model: 'Logi M720', 'Item Type': 'Mouse' }), 'bacc', {}, raw);
  assert.deepEqual(J(o.fix['Connection Type'].vals), ['Bluetooth']);
  assert.match(o.fix['Connection Type'].why, /2 of 3/);
  assert.equal(o.V['Connection Type'], undefined);
  assert.equal(o.fix.Color, undefined);
  o = T.scNormalizeBuild(build({ Model: 'Mystery thing' }), 'bacc', {}, raw);
  assert.equal(o.fix && o.fix['Connection Type'], undefined, 'no history, unknown type: blank');
  o = T.scNormalizeBuild(build({ Model: 'X', 'Connection Type': ['Bluetooth'], 'Item Type': 'Mouse' }), 'bacc', {}, raw);
  assert.equal(o.fix && o.fix['Connection Type'], undefined, 'already answered');
});
test('accessory: Item Type from the model name, only when exactly one type matches', () => {
  assert.equal(T.scAccType('Dell 27 Monitor'), 'Monitor');
  assert.equal(T.scAccType('Sony WH-1000XM4 Headphones'), 'Headphones');
  assert.equal(T.scAccType('AirPods Pro'), 'Earbuds');
  assert.equal(T.scAccType('Keyboard and Mouse combo'), null);
  assert.equal(T.scAccType('Widget 3000'), null);
  const o = T.scNormalizeBuild(build({ Model: 'Razer Basilisk Mouse' }), 'bacc', {});
  assert.deepEqual(J(o.fix['Item Type'].vals), ['Mouse']);
  assert.equal(o.V['Item Type'], undefined, 'tap chip only');
});
test('bpc and unknown forms pass through untouched by the new code', () => {
  const b = build({ 'PC model': 'X' });
  assert.equal(T.scNormalizeBuild(b, 'sphone', NOTE), b);
  assert.equal(T.scExtraBuild(b, 'bpc', NOTE), b);
});
test('flags: each one turns its chip off; master flag off = plain scan', () => {
  const off = n => load(s => s.replace(new RegExp(n + '=true'), n + '=false'));
  const accV = { Model: 'Razer Basilisk Mouse' }, raw = rowsOf('Razer Basilisk Mouse', ['Bluetooth', 'Bluetooth']);
  assert.equal(Object.keys(off('SC_PHONE_CHARGER_ON').scNormalizeBuild(build({}), 'bphone', NOTE).fix).length, 0);
  assert.equal(off('SC_ACC_CHARGER_ON').scNormalizeBuild(build(accV), 'bacc', NOTE, raw).fix['Included Accessories'], undefined);
  assert.equal(off('SC_ACC_CONN_ON').scNormalizeBuild(build(accV), 'bacc', NOTE, raw).fix['Connection Type'], undefined);
  assert.equal(off('SC_ACC_TYPE_ON').scNormalizeBuild(build(accV), 'bacc', NOTE, raw).fix['Item Type'], undefined);
  const b = build(accV);
  assert.equal(off('SC_EXTRA_ON').scNormalizeBuild(b, 'bacc', NOTE, raw), b);
});
test('a throwing helper falls back to the plain scan result', () => {
  const t = load(s => s.replace('function scExtraBuild(b,formId,res,rawIn){', 'function scExtraBuild(b,formId,res,rawIn){throw new Error("boom");'));
  const b = build({ Model: 'Mouse' });
  assert.equal(t.scNormalizeBuild(b, 'bacc', NOTE), b);
});
test('wiring: the five flags default ON, chip render carries data-multi, tap handler has a multi path', () => {
  for (const n of ['SC_EXTRA_ON', 'SC_PHONE_CHARGER_ON', 'SC_ACC_CHARGER_ON', 'SC_ACC_CONN_ON', 'SC_ACC_TYPE_ON']) assert.match(html0, new RegExp(n + '=true'));
  assert.match(html0, /data-sc="fix"[^`]*\$\{b\.fix\[k\]\.multi\?' data-multi="1"':''\}/);
  assert.match(html0, /a==='fix'&&t\.dataset\.multi==='1'/);
});

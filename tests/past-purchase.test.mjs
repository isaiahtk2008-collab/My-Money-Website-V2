// Run with: node --test tests/past-purchase.test.mjs
// Loads the REAL scBuild + scHistory out of index.html (fake bought rows only, no real names, serials or IMEIs) and proves the Phase 1 rules:
//  - a strong ID match fills only the FIXED fields (model, and CPU / screen on the PC form); RAM, storage, colour are never pre-filled
//  - a near / ambiguous match fills nothing; past rows that disagree fill nothing
//  - the photo's value wins over history (and a check is shown); every value from history is tagged
//  - no history means the result is identical to today's; history never sends or stores anything
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const constLine = name => { const m = html.match(new RegExp('^const ' + name + '=.*$', 'm')); if (!m) throw new Error(name + ' not found'); return m[0]; };
function fnBlock(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  let i = html.indexOf('{', html.indexOf(')', start)), d = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') d++;
    else if (html[i] === '}') { d--; if (d === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
const parseBlock = html.slice(html.indexOf('/*OCR-PARSE-START*/'), html.indexOf('/*OCR-PARSE-END*/'));
const fld = (k, extra = {}) => Object.assign({ k, l: k, t: 'text', o: [] }, extra);
const BY = {
  bpc: { t: 'Bought PC', kind: 'PC', f: ['Serial Number', 'PC model', 'Color', 'CPU (and specs)', 'GPU 1 (and specs)', 'GPU 2 (and specs)', 'RAM', 'Storage (SSD, HDD or NVME)', 'Screen Size, Hertz', 'Notes'].map(k => fld(k)) },
  bphone: { t: 'Bought phone', kind: 'Phone', f: ['Serial Number', 'Phone Model', 'Color', 'Storage (GB)', 'Notes'].map(k => fld(k)) },
  bacc: { t: 'Bought accessory', kind: 'Accessory', f: ['Item Type', 'Serial Number', 'Model', 'Color', 'Connection Type', 'Notes'].map(k => fld(k)) }
};
// `store` is deliberately NOT defined in this sandbox: scBuild must work with no store at all.
const ctx = vm.createContext({ BY, unsold: () => [] });
vm.runInContext([
  constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
  parseBlock, fnBlock('scF'), fnBlock('scHas'), 'const SC_NOTE={battery:"Battery",software:"Software",storage:"Storage",display:"Display",cosmetic:"Cosmetic",included:"Included",other:"Other"};',
  constLine('SC_HIST_TAB'), constLine('SC_HIST_FIXED'), constLine('SC_HIST_VAR'), fnBlock('scHistory'), fnBlock('scBuild'),
  'globalThis.__t={scBuild,scHistory};'
].join('\n'), ctx);
const T = ctx.__t;
const J = x => JSON.parse(JSON.stringify(x));

// ---- fake bought rows (fake models, fake notes; same column layout as the real tabs) ----
const pcRow = (model, o = {}) => Object.assign({ 'PC model': model, 'CPU (and specs)': 'Test Chip X1', 'Screen Size, Hertz': '13-inch', RAM: '8GB', 'Storage (SSD, HDD or NVME)': '256GB', Color: 'Silver', Notes: 'Model number: A9001; Battery: Maximum Capacity 90%' }, o);
const RAW = rows => ({ BoughtPCs: { rows }, BoughtPhones: { rows: [] }, BoughtAccess: { rows: [] } });
const F = (v, conf = 'high', extra = {}) => Object.assign({ value: v, confidence: conf, evidence: String(v), image: 1 }, extra);
const scan = (fields, notes = []) => ({ deviceType: 'pc', accessoryType: null, fields, notes, conflicts: [] });
const NOTE_ID = { kind: 'other', text: 'Model number: A9001', image: 1 };

test('exact model-number match fills ONLY the fixed fields (model, CPU, screen); each is tagged from history', () => {
  const raw = RAW([pcRow('TestBook Air (13-inch, X1, 2020)'), pcRow('TestBook Air (13-inch, X1, 2020)', { RAM: '16GB', Color: 'Gold' })]);
  const b = J(T.scBuild('bpc', scan({}, [NOTE_ID]), raw));
  assert.equal(b.V['PC model'], 'TestBook Air (13-inch, X1, 2020)');
  assert.equal(b.V['CPU (and specs)'], 'Test Chip X1');
  assert.equal(b.V['Screen Size, Hertz'], '13-inch');
  for (const k of ['PC model', 'CPU (and specs)', 'Screen Size, Hertz']) assert.equal(b.filled.find(x => x.k === k).hist, true, k + ' is tagged');
  for (const k of ['RAM', 'Storage (SSD, HDD or NVME)', 'Color']) assert.equal(b.V[k], undefined, k + ' is never pre-filled');
});

test('variable fields (RAM, storage, colour) are only OFFERED, most common first, and never put in the form', () => {
  const raw = RAW([pcRow('TestBook Air (13-inch, X1, 2020)'), pcRow('TestBook Air (13-inch, X1, 2020)'), pcRow('TestBook Air (13-inch, X1, 2020)', { RAM: '16GB', Color: 'Gold' })]);
  const b = J(T.scBuild('bpc', scan({}, [NOTE_ID]), raw));
  assert.deepEqual(b.suggest.RAM, ['8GB', '16GB']);
  assert.deepEqual(b.suggest.Color, ['Silver', 'Gold']);
  assert.equal(b.V.RAM, undefined); assert.equal(b.V.Color, undefined);
  assert.equal(b.filled.some(x => ['RAM', 'Color', 'Storage (SSD, HDD or NVME)'].includes(x.k)), false);
});

test('a value read from the photo is never offered or overwritten: it wins over history', () => {
  const raw = RAW([pcRow('TestBook Air (13-inch, X1, 2020)')]);
  const b = J(T.scBuild('bpc', scan({ ram: F('16 GB'), cpu: F('Test Chip X2'), model: F('TestBook Air (13-inch, X1, 2020)') }, [NOTE_ID]), raw));
  assert.equal(b.V.RAM, '16GB', 'RAM comes from the photo');
  assert.equal(b.suggest.RAM, undefined, 'no suggestion where the photo already gave a value');
  assert.equal(b.V['CPU (and specs)'], 'Test Chip X2', 'photo CPU kept');
  assert.ok(b.checks.some(c => /photo shows "Test Chip X2"/.test(c) && /Test Chip X1/.test(c)), 'a check explains the disagreement');
  assert.equal(b.filled.find(x => x.k === 'CPU (and specs)').hist, undefined, 'photo value is not tagged as history');
});

test('near match fills nothing: different model, a partial name, or a name with no strong ID', () => {
  const raw = RAW([pcRow('TestBook Air (13-inch, X1, 2020)', { Notes: '' }), pcRow('TestBook Air (13-inch, X1, 2020)', { Notes: '' })]);
  for (const name of ['TestBook Air (13-inch, X2, 2022)', 'TestBook Air', 'TestBook Air (13-inch, X1, 2020) Pro']) {
    const b = J(T.scBuild('bpc', scan({ model: F(name, 'medium') }), raw));
    assert.equal(b.V['CPU (and specs)'], undefined, name);
    assert.equal(b.V['Screen Size, Hertz'], undefined, name);
    assert.deepEqual(b.suggest, {}, name);
  }
  // a different model number does not match a row that has another one
  const n2 = scan({}, [{ kind: 'other', text: 'Model number: A9002', image: 1 }]);
  const b2 = J(T.scBuild('bpc', n2, RAW([pcRow('TestBook Air (13-inch, X1, 2020)')])));
  assert.deepEqual(b2.V, J(T.scBuild('bpc', n2, null)).V, 'identical to the no-history result'); assert.deepEqual(b2.suggest, {});
  // a low-confidence photo name is not a strong enough identifier
  const b3 = J(T.scBuild('bpc', scan({ model: F('TestBook Air (13-inch, X1, 2020)', 'low') }), raw));
  assert.deepEqual(b3.suggest, {});
});

test('name-only match: exact normalised name fills the model check but CPU / screen need two agreeing past purchases', () => {
  const one = RAW([pcRow('TestBook Air (13-inch, X1, 2020)', { Notes: '' })]);
  const two = RAW([pcRow('TestBook Air (13-inch, X1, 2020)', { Notes: '' }), pcRow('testbook air 13-inch x1 2020', { Notes: '' })]);
  const ph = { model: F('TestBook Air (13-inch, X1, 2020)', 'medium') };
  const b1 = J(T.scBuild('bpc', scan(ph), one));
  assert.equal(b1.V['CPU (and specs)'], undefined, 'one past row is not enough without a strong ID');
  const b2 = J(T.scBuild('bpc', scan(ph), two));
  assert.equal(b2.V['CPU (and specs)'], 'Test Chip X1');
});

test('conflicting history fills nothing: same model number but different names, or past rows that disagree on CPU', () => {
  const names = RAW([pcRow('TestBook Air (13-inch, X1, 2020)'), pcRow('TestBook Air (13-inch, Y9, 2021)')]);
  const b = J(T.scBuild('bpc', scan({}, [NOTE_ID]), names));
  assert.deepEqual(b.V, J(T.scBuild('bpc', scan({}, [NOTE_ID]), null)).V, 'identical to the no-history result');
  assert.deepEqual(b.suggest, {}); assert.equal(b.filled.some(x => x.hist), false);
  const cpu = RAW([pcRow('TestBook Air (13-inch, X1, 2020)'), pcRow('TestBook Air (13-inch, X1, 2020)', { 'CPU (and specs)': 'Test Chip X3' })]);
  const b2 = J(T.scBuild('bpc', scan({}, [NOTE_ID]), cpu));
  assert.equal(b2.V['PC model'], 'TestBook Air (13-inch, X1, 2020)', 'the name still agrees');
  assert.equal(b2.V['CPU (and specs)'], undefined, 'the CPU disagrees, so it is skipped');
  // a blank cell in a past row also means "not unanimous"
  const blank = RAW([pcRow('TestBook Air (13-inch, X1, 2020)'), pcRow('TestBook Air (13-inch, X1, 2020)', { 'CPU (and specs)': '' })]);
  assert.equal(J(T.scBuild('bpc', scan({}, [NOTE_ID]), blank)).V['CPU (and specs)'], undefined);
});

test('no history means behaviour identical to today (no store, empty tabs, missing tabs, junk input all give the same result)', () => {
  const res = scan({ model: F('TestBook Air (13-inch, X1, 2020)', 'medium'), ram: F('8 GB') }, [NOTE_ID]);
  const base = J(T.scBuild('bpc', res, null));
  const sans = J(T.scBuild('bpc', res)); // `store` does not exist in this sandbox at all
  for (const raw of [undefined, null, {}, RAW([]), { BoughtPCs: { rows: 'nope' } }, { BoughtPCs: null }, RAW([null, 5, 'x'])]) {
    assert.deepEqual(J(T.scBuild('bpc', res, raw)), base);
  }
  assert.deepEqual(sans, base);
  assert.deepEqual(base.suggest, {});
  assert.equal(base.filled.some(x => x.hist), false);
  // selling forms never use history
  const s = J(T.scBuild('bpc', res, RAW([pcRow('TestBook Air (13-inch, X1, 2020)')])));
  assert.ok(s.V['CPU (and specs)']);
});

test('phone and accessory forms: model only (they have no CPU / screen column); colour and storage are offered, not filled', () => {
  const rows = [{ 'Phone Model': 'TestPhone 5 (SM-T123X)', Color: 'Blue', 'Storage (GB)': '128', Notes: 'Model number: SM-T123X' }, { 'Phone Model': 'TestPhone 5 (SM-T123X)', Color: 'Black', 'Storage (GB)': '256', Notes: 'Model number: SM-T123X' }];
  const raw = { BoughtPhones: { rows }, BoughtPCs: { rows: [] }, BoughtAccess: { rows: [] } };
  const b = J(T.scBuild('bphone', { deviceType: 'phone', fields: {}, notes: [{ kind: 'other', text: 'Model number: SM-T123X', image: 1 }], conflicts: [] }, raw));
  assert.equal(b.V['Phone Model'], 'TestPhone 5 (SM-T123X)');
  assert.equal(b.V.Color, undefined); assert.equal(b.V['Storage (GB)'], undefined);
  assert.deepEqual(b.suggest.Color, ['Blue', 'Black']);
  assert.deepEqual(b.suggest['Storage (GB)'], ['128', '256']);
  const acc = { BoughtAccess: { rows: [{ Model: 'TestMouse 2', Color: 'Black', Notes: 'Model number: ZX-44A1' }] }, BoughtPCs: { rows: [] }, BoughtPhones: { rows: [] } };
  const a = J(T.scBuild('bacc', { deviceType: 'accessory', accessoryType: null, fields: {}, notes: [{ kind: 'other', text: 'Model number: ZX-44A1', image: 1 }], conflicts: [] }, acc));
  assert.equal(a.V.Model, 'TestMouse 2'); assert.equal(a.V.Color, undefined);
});

test('history never sends or stores anything: the helper and its hook contain no network, storage or sheet calls', () => {
  const src = fnBlock('scHistory') + constLine('SC_HIST_TAB') + constLine('SC_HIST_FIXED') + constLine('SC_HIST_VAR');
  assert.doesNotMatch(src, /fetch|XMLHttpRequest|sendBeacon|LS\.|localStorage|sessionStorage|store\.set|postJSON|queue|J\(|\bV\[/);
  const hook = fnBlock('scBuild');
  const i = hook.indexOf('past purchases (additive)'), j = hook.indexOf('Notes: everything that has no field');
  assert.ok(i > 0 && j > i);
  assert.doesNotMatch(hook.slice(i, j), /fetch|LS\.|localStorage|store\.set|queue/);
  // the input rows are not changed
  const rows = [pcRow('TestBook Air (13-inch, X1, 2020)')], before = JSON.stringify(rows);
  T.scBuild('bpc', scan({}, [NOTE_ID]), RAW(rows));
  assert.equal(JSON.stringify(rows), before);
});

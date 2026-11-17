// Run with: node --test tests/photo-ocr-v2.test.mjs
// Loads the REAL no-AI reader (scOcrParse, scFixGB, scMerge...) and scBuild out of index.html and proves the second round of improvements:
//  - a lost decimal point ("24511 GB") is repaired to a real drive size; a so-so reading of a value with a real spec shape is filled as "double-check", not dropped
//  - Mac / PC / phone models are recognised (name lines, Apple model identifiers and A-numbers, PC brand lines), without inventing conflicts
//  - CPU, GPU, RAM, storage, screen (+ refresh rate) are recognised with or without a label
//  - Smart read (scMerge): AI + on-device readings agree -> solid; disagree -> flagged or blank; one missing -> the other fills in
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
assert.ok(parseBlock.includes('function scMerge(') && parseBlock.includes('function scFixGB('), 'new reader functions are inside the tested block');

const fld = (k, extra = {}) => Object.assign({ k, l: k, t: 'text', o: [] }, extra);
const BY = {
  bpc: { t: 'Bought PC', kind: 'PC', f: [fld('Serial Number'), fld('PC model'), fld('Color'), fld('CPU (and specs)'), fld('GPU 1 (and specs)'), fld('RAM'), fld('Storage (SSD, HDD or NVME)'), fld('Screen Size, Hertz'), fld('Notes')] }
};
const ctx = vm.createContext({ BY, unsold: () => [] });
vm.runInContext([
  constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
  parseBlock, fnBlock('scF'), 'const SC_NOTE={battery:"Battery",software:"Software",storage:"Storage",display:"Display",cosmetic:"Cosmetic",included:"Included",other:"Other"};',
  fnBlock('scBuild'),
  'globalThis.__t={scOcrParse,scFixGB,scMerge,scBuild};'
].join('\n'), ctx);
const T = ctx.__t;
const J = x => JSON.parse(JSON.stringify(x));
const page = (text, extra = {}) => Object.assign({ n: 1, text, conf: 92, words: [] }, extra);

test('lost decimal point: 24511 GB becomes 245.11 GB, 51200 becomes 512, real sizes are untouched', () => {
  assert.deepEqual(J(T.scFixGB('24511', 'GB')), { n: 245.11, ok: true });
  assert.deepEqual(J(T.scFixGB('245,11', 'GB')), { n: 245.11, ok: true });
  assert.deepEqual(J(T.scFixGB('245.11', 'GB')), { n: 245.11, ok: true });
  assert.deepEqual(J(T.scFixGB('512', 'GB')), { n: 512, ok: true });
  assert.deepEqual(J(T.scFixGB('1', 'TB')), { n: 1, ok: true });
  assert.equal(T.scFixGB('777', 'GB').ok, false, 'not a drive size: not repaired');
  assert.equal(T.scFixGB('abc', 'GB').n, 0);
});

test('screenshot case: a dark, so-so scan ("24511 GB", "13.3-inch" at page score 60) still fills storage and screen as double-check', () => {
  const r = T.scOcrParse([page('About This Mac\nMacintosh HD 214.63 GB available of 24511 GB\nDisplay 13.3-inch (2560 x 1600)', { conf: 60 })]);
  assert.equal(r.fields.storage.totalGB, 245.11);
  assert.equal(r.fields.storage.confidence, 'medium');
  assert.equal(r.fields.screen.value, '13.3-inch');
  assert.equal(r.fields.screen.confidence, 'medium');
  const b = T.scBuild('bpc', J(r));
  assert.equal(b.V['Storage (SSD, HDD or NVME)'], '256GB (shows 245.11 GB)');
  assert.equal(b.V['Screen Size, Hertz'], '13.3-inch');
  assert.ok(!b.checks.some(c => /Storage|Screen/.test(c)), 'nothing left blank for those two');
});

test('a really bad scan (page score 30) is still not trusted', () => {
  const r = T.scOcrParse([page('Macintosh HD 214.63 GB available of 24511 GB', { conf: 30 })]);
  assert.equal(r.fields.storage.confidence, 'low');
});

test('a value that is NOT a real spec shape stays low at a so-so score (no free pass)', () => {
  const r = T.scOcrParse([page('Storage 777 GB', { conf: 60 })]);
  assert.equal(r.fields.storage.confidence, 'low');
});

test('per-line reader score is used when word scores exist', () => {
  const words = [{ t: 'Memory', c: 55, b: null }, { t: '8', c: 60, b: null }, { t: 'GB', c: 58, b: null }];
  const r = T.scOcrParse([page('Memory 8 GB', { conf: 95, words })]);
  assert.equal(r.fields.ram.confidence, 'medium', 'shaky words on a real RAM size: medium at best');
  const r2 = T.scOcrParse([page('Memory 8 GB', { conf: 95, words: [{ t: 'Memory', c: 20 }, { t: '8', c: 20 }, { t: 'GB', c: 20 }] })]);
  assert.equal(r2.fields.ram.confidence, 'low', 'very shaky words: low');
});

test('Mac model: heading + size line, parenthesised line, identifier and A-number', () => {
  assert.equal(T.scOcrParse([page('MacBook Air\n13-inch, M1, 2020')]).fields.model.value, 'MacBook Air (13-inch, M1, 2020)');
  assert.equal(T.scOcrParse([page('MacBook Pro (14-inch, 2021)')]).fields.model.value, 'MacBook Pro (14-inch, 2021)');
  const id = T.scOcrParse([page('Model Identifier: MacBookAir10,1')]);
  assert.equal(id.fields.model.value, 'MacBook Air (13-inch, M1, 2020)');
  assert.ok(id.notes.some(n => n.text === 'Model identifier: MacBookAir10,1'));
  const an = T.scOcrParse([page('MacBook Air (Retina, 13-inch, 2020) Model A2337 EMC 3598')]);
  assert.ok(['MacBook Air (Retina, 13-inch, 2020)', 'MacBook Air (13-inch, M1, 2020)'].includes(an.fields.model.value), an.fields.model.value);
  assert.ok(an.notes.some(n => n.text === 'Model number: A2337'));
  const alone = T.scOcrParse([page('Model A2337')]);
  assert.equal(alone.fields.model.value, 'MacBook Air (13-inch, M1, 2020)');
  assert.equal(T.scOcrParse([page('Model A9999')]).fields.model, null, 'unknown A-number: noted, not guessed');
});

test('the same Mac named two ways in two photos is not a conflict; the longer name wins', () => {
  const r = T.scOcrParse([page('MacBook Air', { n: 1 }), page('MacBook Air\n13-inch, M1, 2020', { n: 2 })]);
  assert.equal(r.fields.model.value, 'MacBook Air (13-inch, M1, 2020)');
  assert.deepEqual(J(r.conflicts), []);
});

test('phones: iPhone / Galaxy / Pixel names, and junk after the name is not swallowed', () => {
  assert.equal(T.scOcrParse([page('iPhone 13 Pro Max')]).fields.model.value, 'iPhone 13 Pro Max');
  assert.equal(T.scOcrParse([page('iPhone 13 Pro Settings')]).fields.model.value, 'iPhone 13 Pro');
  assert.equal(T.scOcrParse([page('Galaxy S23 Ultra')]).fields.model.value, 'Galaxy S23 Ultra');
  assert.equal(T.scOcrParse([page('Pixel 8 Pro')]).fields.model.value, 'Pixel 8 Pro');
  assert.equal(T.scOcrParse([page('iPhone')]).fields.model, null, 'a bare "iPhone" is not a model');
});

test('PC brand lines name the model only when nothing better did', () => {
  assert.equal(T.scOcrParse([page('Lenovo ThinkPad T14 Gen 3')]).fields.model.value, 'ThinkPad T14 Gen 3');
  assert.equal(T.scOcrParse([page('Microsoft Surface Laptop 4')]).fields.model.value, 'Surface Laptop 4');
  assert.equal(T.scOcrParse([page('Dell XPS 13 9310')]).fields.model.value, 'XPS 13 9310');
  const both = T.scOcrParse([page('System Model ROG Zephyrus S GX531GV\nASUS ROG Zephyrus')]);
  assert.equal(both.fields.model.value, 'ROG Zephyrus S GX531GV', 'the labelled model wins over a brand line');
});

test('CPU is recognised without a label and merges with the labelled one', () => {
  assert.equal(T.scOcrParse([page('Intel(R) Core(TM) i5-1135G7 CPU @ 2.40GHz')]).fields.cpu.value, 'Intel Core i5-1135G7');
  assert.equal(T.scOcrParse([page('AMD Ryzen 5 5600H with Radeon Graphics')]).fields.cpu.value, 'AMD Ryzen 5 5600H');
  assert.equal(T.scOcrParse([page('Apple M2 Pro')]).fields.cpu.value, 'Apple M2 Pro');
  const r = T.scOcrParse([page('Processor 12th Gen Intel(R) Core(TM) i5-12400F   2.50 GHz\nIntel(R) Core(TM) i5-12400F CPU @ 2.50GHz')]);
  assert.equal(r.fields.cpu.value, '12th Gen Intel Core i5-12400F');
  assert.deepEqual(J(r.conflicts), []);
});

test('graphics: NVIDIA with or without the brand word is one GPU, Apple GPU, Intel integrated goes second', () => {
  const r = T.scOcrParse([page('Graphics Card NVIDIA GeForce RTX 3050\nGeForce RTX 3050\nIntel(R) UHD Graphics')]);
  assert.equal(r.fields.gpu1.value, 'NVIDIA GeForce RTX 3050');
  assert.match(r.fields.gpu2.value, /Intel UHD Graphics/);
  assert.equal(T.scOcrParse([page('Apple M1 8-core GPU')]).fields.gpu1.value, 'Apple M1 8-core GPU');
});

test('RAM: labelled, "16 GB LPDDR5", "8GB unified memory"; an odd size is low-trust', () => {
  assert.equal(T.scOcrParse([page('Memory 16 GB')]).fields.ram.value, '16 GB');
  assert.equal(T.scOcrParse([page('16 GB LPDDR5')]).fields.ram.value, '16 GB');
  assert.equal(T.scOcrParse([page('8GB unified memory')]).fields.ram.value, '8 GB');
  assert.equal(T.scOcrParse([page('Memory 9 GB', { conf: 60 })]).fields.ram.confidence, 'low');
});

test('storage: "512 GB SSD", "SSD: 1 TB", "free of" lines, Windows drive line', () => {
  assert.equal(T.scOcrParse([page('512 GB SSD')]).fields.storage.totalGB, 512);
  assert.equal(T.scOcrParse([page('SSD: 1 TB')]).fields.storage.totalGB, 1024);
  assert.equal(T.scOcrParse([page('Local Disk (C:) 237 GB free of 475 GB')]).fields.storage.totalGB, 475);
  assert.equal(T.scOcrParse([page('Local Disk (C:) 237 GB free of 475 GB')]).fields.storage.confidence, 'high');
});

test('storage shown two ways (256 GB box size and 245.11 GB settings size) is one size, not a conflict', () => {
  const r = T.scOcrParse([page('Storage 256 GB SSD', { n: 1 }), page('Macintosh HD 214.63 GB available of 245.11 GB', { n: 2 })]);
  assert.deepEqual(J(r.conflicts), []);
  assert.equal(r.fields.storage.totalGB, 245.11, 'the real total is preferred');
});

test('screen: comma decimal, "l3.3" slip, refresh rate on another line, nominal vs real size is not a conflict', () => {
  assert.equal(T.scOcrParse([page('Display 13,3-inch')]).fields.screen.value, '13.3-inch');
  assert.equal(T.scOcrParse([page('Display l3.3-inch')]).fields.screen.value, '13.3-inch');
  assert.equal(T.scOcrParse([page('Display 15.6-inch\nRefresh rate 144 Hz')]).fields.screen.value, '15.6-inch, 144Hz');
  const r = T.scOcrParse([page('13-inch, M1, 2020', { n: 1 }), page('Display 13.3-inch', { n: 2 })]);
  assert.deepEqual(J(r.conflicts), []);
  assert.equal(r.fields.screen.value, '13.3-inch');
  assert.equal(T.scOcrParse([page('Display 8-inch')]).fields.screen, null, 'one-digit sizes are phones: not read as a PC screen');
});

test('device type: phone vs PC clues vote; IMEI means phone; Galaxy Book is a PC', () => {
  assert.equal(T.scOcrParse([page('Android version 14\nGalaxy S23 Ultra')]).deviceType, 'phone');
  assert.equal(T.scOcrParse([page('Windows 11 Home\nInstalled RAM 16 GB')]).deviceType, 'pc');
  assert.equal(T.scOcrParse([page('Galaxy Book3 Pro\nWindows 11 Home')]).deviceType, 'pc');
  assert.equal(T.scOcrParse([page('MacBook Air\nmacOS Sequoia 15.3')]).deviceType, 'pc');
});

test('Windows identifyingnumber (wmic csproduct) is read as a serial', () => {
  assert.equal(T.scOcrParse([page('wmic csproduct get identifyingnumber\nIdentifyingNumber\nPF2ABCDE')]).fields.serial.value, 'PF2ABCDE');
});

test('odd input still never throws', () => {
  [null, undefined, 5, 'x', [], [null], [{}], [{ text: null }], [{ text: 42, words: 'no' }], [page('')], [{ text: 'Memory 8 GB', words: [null, {}, { t: 5 }] }]]
    .forEach(x => assert.doesNotThrow(() => T.scOcrParse(x)));
});

// ---------------- Smart read merge ----------------
const F = (value, confidence = 'high', extra = {}) => Object.assign({ value, confidence, evidence: 'x', image: 1 }, extra);
const ai = (fields, extra = {}) => Object.assign({ deviceType: 'pc', accessoryType: null, fields, notes: [], conflicts: [] }, extra);

test('merge: both agree -> solid (high), the AI wording wins, the on-device storage total is kept', () => {
  const m = T.scMerge(
    ai({ ram: F('16 GB', 'medium'), cpu: F('Intel Core i5-12400F', 'high'), storage: F('512 GB', 'high') }),
    ai({ ram: F('16 GB', 'medium'), cpu: F('12th Gen Intel Core i5-12400F', 'medium'), storage: F('476.94 GB', 'medium', { totalGB: 476.94 }) }));
  assert.equal(m.fields.ram.confidence, 'high');
  assert.equal(m.fields.cpu.confidence, 'high');
  assert.equal(m.fields.cpu.value, 'Intel Core i5-12400F');
  assert.equal(m.fields.storage.confidence, 'high');
  assert.equal(m.fields.storage.totalGB, 476.94);
  assert.deepEqual(J(m.conflicts), []);
});

test('merge: serial agree -> high with the on-device zoomed crop; serial differ -> BLANK with both values shown; one source -> kept', () => {
  const crop = 'data:image/jpeg;base64,/9j/4AAQ';
  let m = T.scMerge(ai({ serial: F('hrtj5blu q6l4', 'high') }), ai({ serial: F('HRTJ5BLUQ6L4', 'medium', { crop }) }));
  assert.equal(m.fields.serial.confidence, 'high');
  assert.equal(m.fields.serial.crop, crop);
  m = T.scMerge(ai({ serial: F('HRTJ5BLUQ6L4') }), ai({ serial: F('HRTISBLUQ6L4', 'medium') }));
  assert.equal(m.fields.serial, null);
  assert.ok(m.conflicts.some(c => c.includes('HRTJ5BLUQ6L4') && c.includes('HRTISBLUQ6L4')));
  m = T.scMerge(ai({ serial: F('ABCDE12345') }), ai({ serial: null }));
  assert.equal(m.fields.serial.value, 'ABCDE12345');
  m = T.scMerge(ai({ serial: null }), ai({ serial: F('ABCDE12345', 'medium') }));
  assert.equal(m.fields.serial.value, 'ABCDE12345');
});

test('merge: IMEI prefers the on-device (check-digit verified) one and keeps the AI one in Notes when they differ', () => {
  const m = T.scMerge(ai({ imei: F('354321098765432') }), ai({ imei: F('354321098765433', 'high') }));
  assert.equal(m.fields.imei.value, '354321098765433');
  assert.ok(m.notes.some(n => /354321098765432/.test(n.text)));
});

test('merge: specs disagree -> on-device text used (if it was sure) but flagged double-check with a message; unsure on-device -> AI used', () => {
  let m = T.scMerge(ai({ ram: F('16 GB', 'high') }), ai({ ram: F('8 GB', 'medium') }));
  assert.equal(m.fields.ram.value, '8 GB');
  assert.equal(m.fields.ram.confidence, 'medium');
  assert.ok(m.conflicts.some(c => /RAM/.test(c) && /16 GB/.test(c) && /8 GB/.test(c)));
  m = T.scMerge(ai({ ram: F('16 GB', 'high') }), ai({ ram: F('8 GB', 'low') }));
  assert.equal(m.fields.ram.value, '16 GB');
  assert.equal(m.fields.ram.confidence, 'medium');
});

test('merge: AI-only fields (colour, what is included) and the AI model are kept; the on-device reader only fills gaps', () => {
  const m = T.scMerge(
    ai({ color: F('Space Gray'), chargerIncluded: F(true), model: F('MacBook Air M1') }),
    ai({ model: F('MacBook Air (13-inch, M1, 2020)', 'medium'), cpu: F('Apple M1', 'medium') }));
  assert.equal(m.fields.color.value, 'Space Gray');
  assert.equal(m.fields.chargerIncluded.value, true);
  assert.equal(m.fields.model.value, 'MacBook Air M1', 'the AI model name is kept');
  assert.equal(m.fields.cpu.value, 'Apple M1', 'the gap is filled from the on-device reading');
});

test('merge: notes are combined without duplicates; conflicts from both are kept; the device type comes from the AI', () => {
  const m = T.scMerge(
    ai({}, { deviceType: 'phone', notes: [{ kind: 'battery', text: 'Maximum Capacity 81%' }], conflicts: ['a'] }),
    ai({}, { deviceType: 'pc', notes: [{ kind: 'battery', text: 'Maximum Capacity 81%' }, { kind: 'other', text: 'Model number: A2337' }], conflicts: ['b'] }));
  assert.equal(m.deviceType, 'phone');
  assert.equal(m.notes.length, 2);
  assert.deepEqual(J(m.conflicts), ['a', 'b']);
});

test('merge: an unclear AI device type falls back to the on-device type; odd input never throws', () => {
  assert.equal(T.scMerge(ai({}, { deviceType: 'unknown' }), ai({}, { deviceType: 'pc' })).deviceType, 'pc');
  [[null, null], [undefined, {}], [{}, undefined], [{ fields: 5 }, { fields: [] }], [{ fields: { ram: 7 } }, { fields: { ram: null } }]]
    .forEach(([a, b]) => assert.doesNotThrow(() => T.scMerge(a, b)));
});

test('merged result goes through scBuild like any other: agreed serial fills, disagreeing serial is blank with a message', () => {
  let b = T.scBuild('bpc', J(T.scMerge(ai({ serial: F('PF2ABCDE'), ram: F('16 GB', 'high') }), ai({ serial: F('PF2ABCDE', 'medium') }))));
  assert.equal(b.V['Serial Number'], 'PF2ABCDE');
  assert.equal(b.V['RAM'], '16GB');
  b = T.scBuild('bpc', J(T.scMerge(ai({ serial: F('PF2ABCDE') }), ai({ serial: F('PF2ABCDF', 'medium') }))));
  assert.equal(b.V['Serial Number'], undefined);
  assert.ok(b.checks.some(c => /Photos disagree/.test(c)));
});

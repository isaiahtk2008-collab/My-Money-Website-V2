// Run with: node --test tests/photo-ocr-real.test.mjs
// Regression tests built from REAL phone-camera photos of two computers (a pink custom-built PC and an Acer Nitro laptop): the text is what Tesseract
// actually returned (tests/fixtures/real-ocr-windows.json, machine IDs removed). It has the problems real photos have: Windows Settings cards read as a
// block of labels followed by a block of values, "RTX" read as "RIX", a stray "6.0 GB", UI text next to the device name, a battery serial that is not the computer's.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const REAL = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'real-ocr-windows.json'), 'utf8'));
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
const BY = { bpc: { t: 'Bought PC', kind: 'PC', f: [fld('Serial Number'), fld('PC model'), fld('Color'), fld('CPU (and specs)'), fld('GPU 1 (and specs)'), fld('GPU 2 (and specs)'), fld('RAM'), fld('Storage (SSD, HDD or NVME)'), fld('Screen Size, Hertz'), fld('Notes')] } };
const ctx = vm.createContext({ BY, unsold: () => [] });
vm.runInContext([
  constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
  parseBlock, fnBlock('scF'), 'const SC_NOTE={battery:"Battery",software:"Software",storage:"Storage",display:"Display",cosmetic:"Cosmetic",included:"Included",other:"Other"};',
  fnBlock('scBuild'), 'globalThis.__t={scOcrParse,scBuild};'
].join('\n'), ctx);
const T = ctx.__t, J = x => JSON.parse(JSON.stringify(x));
const pg = (k, n = 1) => ({ n, text: REAL[k].text, conf: REAL[k].conf, words: [] });
const page = (text, extra = {}) => Object.assign({ n: 1, text, conf: 85, words: [] }, extra);

test('real photo, custom PC About screen: CPU, GPU, RAM and drive are read; no junk model or processor', () => {
  const r = T.scOcrParse([pg('pc_about')]);
  assert.equal(r.deviceType, 'pc');
  assert.equal(r.fields.cpu.value, 'Intel Core i5-9600K');
  assert.equal(r.fields.gpu1.value, 'NVIDIA GeForce RTX 2060', '"RIX" is repaired to RTX');
  assert.equal(r.fields.ram.value, '16 GB');
  assert.equal(r.fields.storage.totalGB, 932);
  assert.equal(r.fields.model, null, '"System Product Name" and Settings UI text are never a model');
  assert.equal(r.fields.serial, null);
  assert.deepEqual(J(r.conflicts), []);
  const b = T.scBuild('bpc', J(r));
  assert.equal(b.V['CPU (and specs)'], 'Intel Core i5-9600K');
  assert.equal(b.V['GPU 1 (and specs)'], 'NVIDIA GeForce RTX 2060');
  assert.equal(b.V['RAM'], '16GB');
  assert.equal(b.V['Storage (SSD, HDD or NVME)'], '1TB (shows 932 GB)');
  assert.equal(b.V['PC model'], undefined);
});

test('real photos, Acer laptop (About + battery report + display + About): model, CPU, RAM, drive, OS, battery health, display', () => {
  const r = T.scOcrParse(['laptop_battery', 'laptop_display', 'laptop_about'].map((k, i) => pg(k, i + 1)));
  assert.equal(r.deviceType, 'pc');
  assert.equal(r.fields.model.value, 'Acer Nitro ANV15-51');
  assert.equal(r.fields.cpu.value, '13th Gen Intel Core i5-13420H');
  assert.equal(r.fields.ram.value, '16 GB');
  assert.equal(r.fields.storage.totalGB, 477);
  assert.equal(r.fields.os.value, 'Windows 11 Home');
  assert.ok(r.notes.some(n => n.kind === 'battery' && /Battery health 96% \(full charge 55,132 mWh of 57,488 mWh design\)/.test(n.text)), JSON.stringify(r.notes));
  assert.ok(r.notes.some(n => n.kind === 'display' && /Resolution 1920 × 1080, 165 Hz/.test(n.text)));
  assert.deepEqual(J(r.conflicts), []);
  const b = T.scBuild('bpc', J(r));
  assert.equal(b.V['PC model'], 'Acer Nitro ANV15-51');
  assert.equal(b.V['Storage (SSD, HDD or NVME)'], '512GB (shows 477 GB)');
  assert.equal(b.V['RAM'], '16GB');
});

test('a Windows battery report: its serial number is the BATTERY\'s and is never used as the computer\'s serial; health and cycle count are worked out', () => {
  const r = T.scOcrParse([pg('laptop_battery')]);
  assert.equal(r.fields.serial, null);
  assert.ok(r.notes.some(n => /Battery health 96%/.test(n.text)));
  const blk = T.scOcrParse([page('DESIGN CAPACITY\nFULL CHARGE CAPACITY\nCYCLE COUNT\nLGC\n57,488 mWh\n55,132 mWh\n68')]);
  assert.ok(blk.notes.some(n => /Battery health 96%/.test(n.text)) && blk.notes.some(n => n.text === 'Cycle count 68'), JSON.stringify(blk.notes));
  const long = T.scOcrParse([page('Battery report\nInstalled batteries\nSERIAL NUMBER ABC123456789')]);
  assert.equal(long.fields.serial, null, 'even a long battery serial');
  assert.equal(T.scOcrParse([page('Serial number ABC123456789')]).fields.serial.value, 'ABC123456789', 'a normal page still reads its serial');
});

test('Windows label-block / value-block layout: values are recognised by shape without their labels', () => {
  const r = T.scOcrParse([page('Storage Graphics Card Installed RAM Processor\n477 GB 6 GB 16.0 GB\n13th Gen Intel(R)\nCore(TM) i5-13420H\nLAPTOP-DNTG4FMA\nNitro ANV15-51')]);
  assert.equal(r.fields.ram.value, '16 GB', 'the .0 shape is RAM, the lone "6 GB" is the graphics card');
  assert.equal(r.fields.storage.totalGB, 477);
  assert.equal(r.fields.cpu.value, '13th Gen Intel Core i5-13420H');
  assert.equal(r.fields.model.value, 'Nitro ANV15-51');
});

test('the line under the Windows device name is a model only when it looks like one', () => {
  ['System Product Name', 'Rename this PC', 'K Accessibility', 'Privacy & security', 'To Be Filled By O.E.M.', 'Windows 11 Home'].forEach(under => {
    assert.equal(T.scOcrParse([page('DESKTOP-3205EL5\n' + under)]).fields.model, null, under);
  });
  assert.equal(T.scOcrParse([page('LAPTOP-AB12CD3\nVivobook S15 M3502')]).fields.model.value, 'Vivobook S15 M3502');
});

test('a labelled "processor" must look like a CPU (a whole line of UI text is rejected)', () => {
  assert.equal(T.scOcrParse([page('Processor ® installed RAM & Graphics card B Storage |)')]).fields.cpu, null);
  assert.equal(T.scOcrParse([page('Processor 12th Gen Intel(R) Core(TM) i5-12400F (2.50 GHz)')]).fields.cpu.value, '12th Gen Intel Core i5-12400F');
});

test('CPU clean-up: "CPU @ 3.70GHz (3.70 GHz)" is dropped, a lower-case suffix letter is repaired', () => {
  assert.equal(T.scOcrParse([page('Processor Intel(R) Core(TM) i5-9600K CPU @ 3.70GHz (3.70 GHz)')]).fields.cpu.value, 'Intel Core i5-9600K');
  assert.equal(T.scOcrParse([page('Core(TM) i5-9600k')]).fields.cpu.value, 'Intel Core i5-9600K');
});

test('GPU: RTX/GTX misread as RIX/GIX is repaired; an RTX card with no readable number goes to Notes instead of being invented', () => {
  assert.equal(T.scOcrParse([page('Graphics card NVIDIA GeForce RIX 2060 (6 GB)')]).fields.gpu1.value, 'NVIDIA GeForce RTX 2060');
  assert.equal(T.scOcrParse([page('GeForce GIX 1650')]).fields.gpu1.value, 'NVIDIA GeForce GTX 1650');
  const r = T.scOcrParse([page('GPU 1\nNVIDIA GeForce RTX\n0% (54 °C)')]);
  assert.equal(r.fields.gpu1, null);
  assert.ok(r.notes.some(n => /NVIDIA GeForce RTX card is installed/.test(n.text)));
});

test('a clear majority of readings beats one stray misread for specs, but a serial number must agree exactly', () => {
  const r = T.scOcrParse([page('Installed RAM 16.0 GB', { n: 1 }), page('Installed RAM 16.0 GB', { n: 2 }), page('Installed RAM 16.0 GB', { n: 3 }), page('Installed RAM 6.0 GB', { n: 4 })]);
  assert.equal(r.fields.ram.value, '16 GB');
  assert.deepEqual(J(r.conflicts), []);
  const tie = T.scOcrParse([page('Installed RAM 16.0 GB', { n: 1 }), page('Installed RAM 8.0 GB', { n: 2 })]);
  assert.equal(tie.fields.ram, null, 'a tie is still a conflict');
  assert.ok(tie.conflicts.some(c => /RAM/.test(c)));
  const s = T.scOcrParse(['A', 'A', 'A', 'B'].map((x, i) => page('Serial number HRTJ5BLUQ6L' + (x === 'A' ? '4' : '9'), { n: i + 1 })));
  assert.equal(s.fields.serial, null, 'serials never vote');
});

test('refresh rate goes to the screen field only when the inch size is known; otherwise it is a display note', () => {
  const a = T.scOcrParse([page('Display 15.6-inch\nDesktop mode 1920 × 1080, 165 Hz')]);
  assert.equal(a.fields.screen.value, '15.6-inch, 165Hz');
  const b = T.scOcrParse([page('Desktop mode 1920 × 1080, 165 Hz')]);
  assert.equal(b.fields.screen, null);
  assert.ok(b.notes.some(n => n.text === 'Resolution 1920 × 1080, 165 Hz'));
});

test('battery health from the labelled form too, and an impossible ratio is ignored', () => {
  assert.ok(T.scOcrParse([page('DESIGN CAPACITY 57,488 mWh\nFULL CHARGE CAPACITY 55,132 mWh')]).notes.some(n => /health 96%/.test(n.text)));
  assert.equal(T.scOcrParse([page('DESIGN CAPACITY 57,488 mWh\nFULL CHARGE CAPACITY 5,132 mWh')]).notes.length, 0);
  assert.equal(T.scOcrParse([page('DESIGN CAPACITY 50,000 mWh\nFULL CHARGE CAPACITY 70,000 mWh')]).notes.length, 0);
});

test('the real-photo fixtures still give the same answer when the pages are shuffled', () => {
  const ks = ['laptop_battery', 'laptop_display', 'laptop_about'];
  const a = T.scOcrParse(ks.map((k, i) => pg(k, i + 1))), b = T.scOcrParse(ks.slice().reverse().map((k, i) => pg(k, i + 1)));
  ['model', 'cpu', 'ram', 'os'].forEach(k => assert.equal(a.fields[k].value, b.fields[k].value, k));
  assert.equal(a.fields.storage.totalGB, b.fields.storage.totalGB);
});

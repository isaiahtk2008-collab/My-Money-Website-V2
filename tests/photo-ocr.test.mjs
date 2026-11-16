// Run with: node --test tests/photo-ocr.test.mjs
// Loads the REAL no-AI photo reader (scOcrParse and helpers) and scBuild out of index.html (no copies) and proves:
//  - Mac, Windows, Android and iPhone screens give the same result shape the AI gives, so the form fill is shared
//  - serial numbers are read the same way on every platform: Apple/Android "Serial number", Windows wmic output, Dell Service Tag, S/N stickers
//  - the Windows "Device ID" code goes to Notes and is NEVER used as the serial; OEM placeholders are never a serial (OCR path and AI path)
//  - an IMEI is accepted only when it passes its check digit; a serial is never "high" confidence
//  - disagreeing photos leave the field blank and say so; odd input never throws
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
assert.ok(parseBlock.length > 500, 'OCR parse block markers not found');

// minimal stand-ins for the forms scBuild fills
const fld = (k, extra = {}) => Object.assign({ k, l: k, t: 'text', o: [] }, extra);
const BY = {
  bpc: { t: 'Bought PC', kind: 'PC', f: [fld('Serial Number'), fld('PC model'), fld('CPU (and specs)'), fld('RAM'), fld('Storage (SSD, HDD or NVME)'), fld('Notes')] },
  bphone: { t: 'Bought phone', kind: 'Phone', f: [fld('Serial Number'), fld('Phone Model'), fld('Storage (GB)'), fld('Notes')] }
};
const ctx = vm.createContext({ BY, unsold: () => [] });
vm.runInContext([
  constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
  parseBlock, fnBlock('scF'), 'const SC_NOTE={battery:"Battery",software:"Software",storage:"Storage",display:"Display",cosmetic:"Cosmetic",included:"Included",other:"Other"};',
  fnBlock('scBuild'),
  'globalThis.__t={scOcrParse,scOcrSerials,scOcrImeis,scBuild,scF};'
].join('\n'), ctx);
const T = ctx.__t;
const arr = x => JSON.parse(JSON.stringify(x));   // results come from another realm: compare plain copies

const page = (text, extra = {}) => Object.assign({ n: 1, text, conf: 92, words: [] }, extra);
const word = (t, c, b = { x0: 10, y0: 10, x1: 120, y1: 30 }) => ({ t, c, b });
const luhnImei = body14 => { let s = 0; for (let i = 0; i < 14; i++) { let n = +body14[i]; if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; } s += n; } return body14 + ((10 - (s % 10)) % 10); };
const IMEI = luhnImei('35432109876543');

const MAC = `About This Mac
MacBook Air
13-inch, M1, 2020
Chip Apple M1
Memory 8 GB
Serial number HRTJ5BLUQ6L4
macOS Sequoia 15.3
Storage
Macintosh HD 214.63 GB available of 245.11 GB
Battery
Maximum Capacity 81%
Cycle Count 212
Condition Normal`;

const WIN_ABOUT = `Device specifications
Device name DESKTOP-4F7Q2
Processor 12th Gen Intel(R) Core(TM) i5-12400F   2.50 GHz
Installed RAM 12.0 GB (11.8 GB usable)
Device ID 6F9A1C2E-3B4D-4E5F-8A7B-9C0D1E2F3A4B
Product ID 00330-80000-00000-AA123
System type 64-bit operating system
Windows specifications
Edition Windows 11 Home
Version 23H2
Graphics Card NVIDIA GeForce RTX 3050`;

test('Mac screen: same result shape as the AI, serial as "double-check", storage total not free space', () => {
  const r = T.scOcrParse([page(MAC, { words: [word('HRTJ5BLUQ6L4', 91)] })]);
  assert.equal(r.deviceType, 'pc');
  assert.equal(r.fields.cpu.value, 'Apple M1');
  assert.equal(r.fields.ram.value, '8 GB');
  assert.equal(r.fields.storage.value, '245.11 GB');
  assert.equal(r.fields.storage.totalGB, 245.11);
  assert.equal(r.fields.os.value, 'macOS Sequoia 15.3');
  assert.equal(r.fields.serial.value, 'HRTJ5BLUQ6L4');
  assert.equal(r.fields.serial.confidence, 'medium', 'an OCR serial is never high');
  assert.ok(r.fields.serial.bbox, 'serial carries its location so a zoomed crop can be shown');
  assert.ok(r.notes.some(n => n.kind === 'battery' && /81%/.test(n.text)));
  assert.ok(r.notes.some(n => /Cycle count 212/.test(n.text)));
  assert.equal(r.fields.color, null, 'colour is never guessed from text');
  ['model', 'color', 'serial', 'imei', 'cpu', 'gpu1', 'gpu2', 'ram', 'storage', 'screen', 'os', 'chargerIncluded', 'boxIncluded', 'caseIncluded', 'connection']
    .forEach(k => assert.ok(k in r.fields, 'missing key ' + k));
});

test('Windows About screen: specs read, Device ID goes to Notes and is NOT the serial', () => {
  const r = T.scOcrParse([page(WIN_ABOUT)]);
  assert.equal(r.deviceType, 'pc');
  assert.match(r.fields.cpu.value, /^12th Gen Intel Core i5-12400F$/);
  assert.equal(r.fields.ram.value, '12 GB');
  assert.equal(r.fields.os.value, 'Windows 11 Home');
  assert.match(r.fields.gpu1.value, /RTX 3050/);
  assert.equal(r.fields.serial, null, 'Device ID must never become the serial');
  assert.ok(r.notes.some(n => n.text === 'Windows Device ID: 6F9A1C2E-3B4D-4E5F-8A7B-9C0D1E2F3A4B'));
  assert.ok(r.notes.some(n => n.text === 'Windows version 23H2'));
});

test('a Device ID written as "Serial number" label-less is still not accepted as a serial (too long, GUID shape)', () => {
  const r = T.scOcrParse([page('Serial number 6F9A1C2E-3B4D-4E5F-8A7B-9C0D1E2F3A4B')]);
  assert.equal(r.fields.serial, null);
});

test('Windows serial from wmic output (label line, value on the next line)', () => {
  const r = T.scOcrParse([page('C:\\> wmic bios get serialnumber\nSerialNumber\nPF2ABCDE\n', { words: [word('PF2ABCDE', 95)] })]);
  assert.equal(r.fields.serial.value, 'PF2ABCDE');
});

test('Windows serial from PowerShell "SerialNumber : value"', () => {
  assert.deepEqual(arr(T.scOcrSerials(page('SerialNumber : PF2ABCDE'))), ['PF2ABCDE']);
});

test('Windows/OEM serials: Dell Service Tag, S/N and SN stickers, "Serial No."', () => {
  assert.deepEqual(arr(T.scOcrSerials(page('Service Tag: 7XK2B93'))), ['7XK2B93']);
  assert.deepEqual(arr(T.scOcrSerials(page('S/N: PF2ABCDE'))), ['PF2ABCDE']);
  assert.deepEqual(arr(T.scOcrSerials(page('S / N PF2ABCDE'))), ['PF2ABCDE']);
  assert.deepEqual(arr(T.scOcrSerials(page('SN: R5CT1234ABC'))), ['R5CT1234ABC']);
  assert.deepEqual(arr(T.scOcrSerials(page('Serial No. 5CG1234ABC'))), ['5CG1234ABC']);
});

test('OEM placeholders and non-values are never a serial', () => {
  ['SerialNumber\nTo Be Filled By O.E.M.', 'SerialNumber\nDefault string', 'Serial number: System Serial Number', 'Serial number: None',
    'Serial number: 0000000000', 'Serial number unknown', 'SerialNumber\n123456789', 'Serial number: Not available'
  ].forEach(t => assert.deepEqual(arr(T.scOcrSerials(page(t))), [], t));
});

test('a word that merely starts with sn/serial is not a label', () => {
  assert.deepEqual(arr(T.scOcrSerials(page('Snapdragon 8 Gen 2\nSerialize options A1B2C3D4'))), []);
});

test('Android About phone: model name, serial, IMEI and OS', () => {
  const r = T.scOcrParse([page(`About phone\nModel name Galaxy S23 Ultra\nModel number SM-S918W\nSerial number R5CT1234ABC\nIMEI (slot 1) ${IMEI}\nAndroid version 14`)]);
  assert.equal(r.deviceType, 'phone');
  assert.equal(r.fields.model.value, 'Galaxy S23 Ultra');
  assert.equal(r.fields.serial.value, 'R5CT1234ABC');
  assert.equal(r.fields.imei.value, IMEI);
  assert.equal(r.fields.imei.confidence, 'high');
  assert.equal(r.fields.os.value, 'Android 14');
  assert.ok(r.notes.some(n => n.text === 'Model number: SM-S918W'));
});

test('iPhone About + storage', () => {
  const r = T.scOcrParse([page(`About\nModel Name iPhone 13 Pro\nSerial Number F2LXK3ABCD\niOS Version 17.1\n52.5 GB of 128 GB Used\nBattery Health Maximum Capacity 87%`)]);
  assert.equal(r.deviceType, 'phone');
  assert.equal(r.fields.model.value, 'iPhone 13 Pro');
  assert.equal(r.fields.serial.value, 'F2LXK3ABCD');
  assert.equal(r.fields.storage.totalGB, 128);
  assert.ok(r.notes.some(n => /87%/.test(n.text)));
});

test('IMEI: must pass the check digit; slot number and OCR letter-for-digit slips are handled', () => {
  assert.deepEqual(arr(T.scOcrImeis(page('IMEI ' + IMEI))), [IMEI]);
  assert.deepEqual(arr(T.scOcrImeis(page('IMEI 1 ' + IMEI))), [IMEI]);
  assert.deepEqual(arr(T.scOcrImeis(page('IMEI\n' + IMEI))), [IMEI]);
  assert.deepEqual(arr(T.scOcrImeis(page('IMEI ' + IMEI.replace('0', 'O')))), [IMEI]);
  const bad = IMEI.slice(0, 14) + ((+IMEI[14] + 1) % 10);
  assert.deepEqual(arr(T.scOcrImeis(page('IMEI ' + bad))), [], 'wrong check digit is rejected');
  assert.deepEqual(arr(T.scOcrImeis(page('IMEI 12345'))), []);
});

test('a second IMEI goes to Notes, never overwrites the first', () => {
  const I2 = luhnImei('35432109876544');
  const r = T.scOcrParse([page(`IMEI 1 ${IMEI}\nIMEI 2 ${I2}\nAndroid version 14`)]);
  assert.equal(r.fields.imei.value, IMEI);
  assert.ok(r.notes.some(n => n.text === 'IMEI 2: ' + I2));
});

test('a shaky serial (low reader confidence) is returned as "low" so the form leaves it blank', () => {
  const r = T.scOcrParse([page('Serial number HRTJ5BLUQ6L4', { words: [word('HRTJ5BLUQ6L4', 51)] })]);
  assert.equal(r.fields.serial.confidence, 'low');
});

test('two photos that disagree about the serial: blank + a conflict message', () => {
  const r = T.scOcrParse([page('Serial number HRTJ5BLUQ6L4', { n: 1 }), page('Serial number HRTISBLUQ6L4', { n: 2 })]);
  assert.equal(r.fields.serial, null);
  assert.ok(r.conflicts.some(c => /serial number/.test(c)));
});

test('the same serial in two photos is fine', () => {
  const r = T.scOcrParse([page('Serial number HRTJ5BLUQ6L4', { n: 1 }), page('S/N HRTJ5BLUQ6L4', { n: 2 })]);
  assert.equal(r.fields.serial.value, 'HRTJ5BLUQ6L4');
});

test('odd input never throws and finds nothing', () => {
  [null, undefined, 5, 'x', [], [null], [{}], [{ text: null }], [{ text: 42 }], [page('')], [page('\n\n   \n')]].forEach(x => {
    const r = T.scOcrParse(x);
    assert.equal(r.deviceType, 'unknown');
    assert.ok(Object.values(r.fields).every(v => v === null));
  });
});

test('scBuild: an OCR Windows serial and specs fill the Bought PC form, Device ID lands in Notes', () => {
  const r = T.scOcrParse([page('SerialNumber\nPF2ABCDE\n' + WIN_ABOUT, { words: [word('PF2ABCDE', 96)] })]);
  const b = T.scBuild('bpc', JSON.parse(JSON.stringify(r)));
  assert.equal(b.V['Serial Number'], 'PF2ABCDE');
  assert.match(b.V['CPU (and specs)'], /i5-12400F/);
  assert.equal(b.V['RAM'], '12GB');
  assert.match(b.V['Notes'], /Windows Device ID: 6F9A1C2E/);
  assert.ok(b.filled.find(x => x.k === 'Serial Number').conf === 'medium');
});

test('scBuild: OEM placeholder and low-confidence serials are left blank, with a message (also for the AI path)', () => {
  const ai = (v, conf) => ({ deviceType: 'pc', fields: { serial: { value: v, confidence: conf, evidence: v, image: 1 }, cpu: { value: 'Intel Core i5', confidence: 'high', evidence: 'x', image: 1 } } });
  let b = T.scBuild('bpc', ai('To Be Filled By O.E.M.', 'high'));
  assert.equal(b.V['Serial Number'], undefined);
  assert.ok(b.checks.some(c => /serial number/i.test(c)));
  b = T.scBuild('bpc', ai('Default string', 'high'));
  assert.equal(b.V['Serial Number'], undefined);
  b = T.scBuild('bpc', ai('PF2ABCDE', 'low'));
  assert.equal(b.V['Serial Number'], undefined);
  b = T.scBuild('bpc', ai('pf2 abcde', 'high'));
  assert.equal(b.V['Serial Number'], 'PF2ABCDE', 'a real serial from the AI still fills');
});

test('scF only passes a small JPEG data URL through as a crop', () => {
  const f = c => T.scF({ serial: { value: 'ABCDE12345', confidence: 'medium', crop: c } }, 'serial');
  assert.ok(f('data:image/jpeg;base64,/9j/4AAQ').crop);
  assert.equal(f('https://evil.example/x.jpg').crop, null);
  assert.equal(f('javascript:alert(1)').crop, null);
  assert.equal(f('data:image/svg+xml;base64,PHN2Zz4=').crop, null);
  assert.equal(f('data:image/jpeg;base64,' + 'A'.repeat(300000)).crop, null);
});

test('real-OCR slips: Device ID with letter O for zero is repaired (hex only), noisy storage line and trailing colon are cleaned', () => {
  const r = T.scOcrParse([page('Device ID 6F9A1C2E-3B4D-4E5F-8A7B-9COD1E2F3A4B\nChip: Apple M1:\nMacintosh HO. 214.63 GB: available of 245.11. GB.')]);
  assert.ok(r.notes.some(n => n.text === 'Windows Device ID: 6F9A1C2E-3B4D-4E5F-8A7B-9C0D1E2F3A4B'));
  assert.equal(r.fields.cpu.value, 'Apple M1');
  assert.equal(r.fields.storage.totalGB, 245.11);
});

test('a misread serial with stray symbols (real OCR of a camera photo) is dropped, not guessed', () => {
  assert.deepEqual(arr(T.scOcrSerials(page('~ Serial number HET/SBLUQELA'))), []);
});

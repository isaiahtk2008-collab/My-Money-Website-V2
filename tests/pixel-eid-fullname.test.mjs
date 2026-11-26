// Run with: node --test tests/pixel-eid-fullname.test.mjs
// Loads the REAL scOcrParse / scBuild out of index.html (masked identifiers only) and proves:
//  - a Pixel's EID (32 digits, passes its mod-97 check) is read from "About phone" and becomes the Serial Number; the IMEI moves to Notes
//  - a misread EID (fails the check) is never filled; non-Pixel phones keep their old serial/IMEI behaviour
//  - phone / PC models get their full name (Google Pixel 9 Pro, Apple ..., HP OMEN 25L GT12); already-branded names are not doubled
//  - the Windows "OMEN 25L Desktop GT12-0xxx" line reads as "OMEN 25L GT12"
//  - the two switches exist; with them off the old output is unchanged
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
const namesBlock = html.slice(html.indexOf('/*SC-NAMES-START*/'), html.indexOf('/*SC-NAMES-END*/'));
const fld = (k, extra = {}) => Object.assign({ k, l: k, t: 'text', o: [] }, extra);
const BY = {
  bphone: { t: 'Bought phone', kind: 'Phone', f: ['Serial Number', 'Phone Model', 'Color', 'Storage (GB)', 'Notes'].map(k => fld(k)) },
  bpc: { t: 'Bought PC', kind: 'PC', f: ['Serial Number', 'PC model', 'Color', 'CPU (and specs)', 'GPU 1 (and specs)', 'GPU 2 (and specs)', 'RAM', 'Storage (SSD, HDD or NVME)', 'Screen Size, Hertz', 'Notes'].map(k => fld(k)) }
};
function load(flags) {
  const ctx = vm.createContext({ BY, unsold: () => [] });
  vm.runInContext([
    constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
    namesBlock.replace('const SC_FULLNAME_ON=true;', 'const SC_FULLNAME_ON=' + flags.name + ';').replace('const SC_PIXEL_EID_ON=true;', 'const SC_PIXEL_EID_ON=' + flags.eid + ';'),
    parseBlock, fnBlock('scF'), fnBlock('scHas'), 'const SC_NOTE={battery:"Battery",software:"Software",storage:"Storage",display:"Display",cosmetic:"Cosmetic",included:"Included",other:"Other"};',
    constLine('SC_HIST_TAB'), constLine('SC_HIST_FIXED'), constLine('SC_HIST_VAR'), fnBlock('scHistory'), fnBlock('scBuild'),
    'globalThis.__t={scOcrParse,scBuild,scFullName,scEidClean,scOcrEids};'
  ].join('\n'), ctx);
  return ctx.__t;
}
const T = load({ name: true, eid: true });
const J = x => JSON.parse(JSON.stringify(x));

// masked stand-ins for the real photo values (the EID passes the same mod-97 check a real one does; the IMEIs pass Luhn)
const EID = '89044321110022003300445566778874';
const IMEI1 = '351311000012340', IMEI2 = '351311000012357';
const ABOUT = ['About phone', 'Device details', 'SIM 1 status', 'Not available', 'SIM 2 status', 'Not available', 'Model', 'Pixel 9 Pro', 'EID', EID, 'IMEI 1', IMEI1, 'IMEI 2', IMEI2, 'Android version', '17', 'Build number', 'CP3A.261005.005', 'Uptime', '10:19:54'].join('\n');
const read = text => J(T.scOcrParse([{ n: 1, text, conf: 90, words: [] }]));

test('EID check: only a real 32-digit EID passes; one wrong digit, wrong length or wrong prefix does not', () => {
  assert.equal(T.scEidClean(EID), EID);
  assert.equal(T.scEidClean(EID.slice(0, 20) + '9' + EID.slice(21)), null, 'one digit off fails the mod-97 check');
  assert.equal(T.scEidClean(EID.slice(0, 31)), null);
  assert.equal(T.scEidClean('9' + EID.slice(1)), null);
  assert.equal(T.scEidClean(EID.replace(/0/g, 'O')), EID, 'O read for 0 is repaired');
  assert.equal(T.scEidClean(''), null);
  assert.equal(T.scEidClean(null), null);
});

test('Pixel About phone photo: model, EID, IMEI and the Android version are all read', () => {
  const r = read(ABOUT);
  assert.equal(r.fields.model.value, 'Pixel 9 Pro');
  assert.equal(r.fields.eid.value, EID);
  assert.equal(r.fields.eid.confidence, 'high');
  assert.equal(r.fields.imei.value, IMEI1);
  assert.equal(r.fields.serial, null, 'the EID is never mistaken for a serial by the reader itself');
  assert.equal(r.deviceType, 'phone');
});

test('the EID wrapped onto two lines is still read; a misread EID gives no eid field', () => {
  const wrapped = read(ABOUT.replace(EID, EID.slice(0, 16) + '\n' + EID.slice(16)));
  assert.equal(wrapped.fields.eid.value, EID);
  const bad = read(ABOUT.replace(EID, EID.slice(0, 20) + '9' + EID.slice(21)));
  assert.equal(bad.fields.eid, null);
});

test('Bought phone form: Pixel serial = EID, IMEI goes to Notes, model is "Google Pixel 9 Pro"', () => {
  const b = J(T.scBuild('bphone', read(ABOUT), null));
  assert.equal(b.V['Serial Number'], EID);
  assert.equal(b.V['Phone Model'], 'Google Pixel 9 Pro');
  assert.match(b.V.Notes, new RegExp('IMEI: ' + IMEI1));
  assert.ok(!b.V.Notes.includes(EID), 'the EID is in the serial field, not repeated in Notes');
});

test('Bought phone form: a Pixel whose EID could not be read does not get the EID, says so, and keeps the IMEI as before', () => {
  const b = J(T.scBuild('bphone', read(ABOUT.replace(EID, EID.slice(0, 20) + '9' + EID.slice(21))), null));
  assert.equal(b.V['Serial Number'], IMEI1);
  assert.equal(b.V['Phone Model'], 'Google Pixel 9 Pro');
});

test('Bought phone form: a non-Pixel phone keeps IMEI as its serial (EID only goes to Notes) and gets its brand', () => {
  const r = J(T.scOcrParse([{ n: 1, text: ['Model name', 'iPhone 13 Pro', 'EID', EID, 'IMEI', IMEI1].join('\n'), conf: 90, words: [] }]));
  const b = J(T.scBuild('bphone', r, null));
  assert.equal(b.V['Serial Number'], IMEI1);
  assert.equal(b.V['Phone Model'], 'Apple iPhone 13 Pro');
  assert.match(b.V.Notes, new RegExp('EID: ' + EID));
});

test('Windows About page of the OMEN 25L: model reads "OMEN 25L GT12" and the form gets "HP OMEN 25L GT12"', () => {
  const text = ['System > About', 'Processor', 'AMD Ryzen 5 3600 6-Core Processor', 'Installed RAM', '16.0 GB', 'Graphics card', '6 GB', 'NVIDIA GeForce RTX 2060',
    'Windows11', 'OMEN 25L Desktop GT12-0xxx', 'Device name Windows11', 'Processor AMD Ryzen 5 3600 6-Core Processor (3.59 GHz)', 'Installed RAM 16.0 GB',
    'Graphics card NVIDIA GeForce RTX 2060 (6 GB)', 'Storage 523 GB of 1.14 TB used'].join('\n');
  const r = read(text);
  assert.equal(r.fields.model.value, 'OMEN 25L GT12');
  assert.match(r.fields.cpu.value, /Ryzen 5 3600/);
  const b = J(T.scBuild('bpc', r, null));
  assert.equal(b.V['PC model'], 'HP OMEN 25L GT12');
});

test('full names: brand added once, only for known product lines, nothing doubled or invented', () => {
  const n = T.scFullName;
  assert.equal(n('Pixel 9 Pro'), 'Google Pixel 9 Pro');
  assert.equal(n('Google Pixel 9 Pro'), 'Google Pixel 9 Pro');
  assert.equal(n('MacBook Air (13-inch, M1, 2020)'), 'Apple MacBook Air (13-inch, M1, 2020)');
  assert.equal(n('Apple MacBook Air M1'), 'Apple MacBook Air M1');
  assert.equal(n('iPhone 15 Pro Max'), 'Apple iPhone 15 Pro Max');
  assert.equal(n('Galaxy S23 Ultra'), 'Samsung Galaxy S23 Ultra');
  assert.equal(n('Surface Laptop 4'), 'Microsoft Surface Laptop 4');
  assert.equal(n('ROG Zephyrus M16 GU603ZM'), 'ASUS ROG Zephyrus M16 GU603ZM');
  assert.equal(n('ThinkPad T14 Gen 3'), 'Lenovo ThinkPad T14 Gen 3');
  assert.equal(n('XPS 13 9310'), 'Dell XPS 13 9310');
  assert.equal(n('OMEN 25L GT12'), 'HP OMEN 25L GT12');
  assert.equal(n('Some Unknown Box 3000'), 'Some Unknown Box 3000');
  assert.equal(n(''), '');
  assert.equal(n(null), '');
});

test('switches: both exist and default ON; with them OFF the old output is unchanged (model as read, IMEI as serial)', () => {
  assert.match(html, /const SC_FULLNAME_ON=true;/);
  assert.match(html, /const SC_PIXEL_EID_ON=true;/);
  const off = load({ name: false, eid: false });
  const b = J(off.scBuild('bphone', J(off.scOcrParse([{ n: 1, text: ABOUT, conf: 90, words: [] }])), null));
  assert.equal(b.V['Serial Number'], IMEI1);
  assert.equal(b.V['Phone Model'], 'Pixel 9 Pro');
});

test('selling a Pixel: the unsold device is matched by its EID (its stored serial)', () => {
  const ctx = vm.createContext({
    BY: { sphone: { t: 'Sold phone', kind: 'Phone', f: [{ k: 'Item', l: 'Item', t: 'item', o: [] }] } },
    unsold: () => [{ l: 'Google Pixel 9 Pro', it: { serial: EID, specs: {} } }]
  });
  vm.runInContext([
    constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
    namesBlock, parseBlock, fnBlock('scF'), fnBlock('scHas'), 'const SC_NOTE={};',
    constLine('SC_HIST_TAB'), constLine('SC_HIST_FIXED'), constLine('SC_HIST_VAR'), fnBlock('scHistory'), fnBlock('scBuild'),
    'globalThis.__t={scOcrParse,scBuild};'
  ].join('\n'), ctx);
  const r = J(ctx.__t.scOcrParse([{ n: 1, text: ABOUT, conf: 90, words: [] }]));
  const b = J(ctx.__t.scBuild('sphone', r, null));
  assert.equal(b.V.Item, 'Google Pixel 9 Pro');
});

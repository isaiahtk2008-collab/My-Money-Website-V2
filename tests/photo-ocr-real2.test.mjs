// Run with: node --test tests/photo-ocr-real2.test.mjs
// Regression test from a REAL phone photo of a monitor showing a Windows 11 Settings > System > About screen (Ryzen 5 5600G / RX 590 GME PC),
// taken at an angle with screen glare. The text is what Tesseract actually returned in two modes (page-segmentation 3 and 11); the machine name is masked.
// Photo problems: the Device info rows come back as labels with no values, "41 GB of 954 GB used" is split by noise, the Edition line is cut off by the photo edge.
// Additive only: no site code is changed by this file.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const REAL = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'real-ocr-windows-2.json'), 'utf8'));
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

for (const k of Object.keys(REAL)) {
  test(`real photo, Ryzen 5 5600G / RX 590 GME About screen (${k}): CPU, GPU, RAM and drive are read; nothing is invented`, () => {
    const r = T.scOcrParse([{ n: 1, text: REAL[k].text, conf: REAL[k].conf, words: [] }]);
    assert.equal(r.deviceType, 'pc');
    assert.equal(r.fields.cpu.value, 'AMD Ryzen 5 5600G', 'the "with Radeon Graphics" tail is not part of the CPU name');
    assert.equal(r.fields.gpu1.value, 'AMD Radeon RX590 GME');
    assert.equal(r.fields.ram.value, '16 GB', '"15.8 GB usable" / "Speed: 2666 MT/s" are never the RAM size');
    assert.equal(r.fields.storage.totalGB, 954, 'the total drive, not the 41 GB used');
    assert.equal(r.fields.model, null, '"System Product Name" / the DESKTOP-... name are never a model');
    assert.equal(r.fields.serial, null, 'Device ID and Product ID are not serial numbers');
    assert.equal(r.fields.os, null, 'the Edition line is cut off in this photo, so the OS stays blank instead of being guessed');
    assert.deepEqual(J(r.conflicts), []);
    const b = T.scBuild('bpc', J(r));
    assert.equal(b.V['CPU (and specs)'], 'AMD Ryzen 5 5600G');
    assert.equal(b.V['GPU 1 (and specs)'], 'AMD Radeon RX590 GME');
    assert.equal(b.V['RAM'], '16GB');
    assert.match(b.V['Storage (SSD, HDD or NVME)'], /^1TB/);
    assert.equal(b.V['PC model'], undefined);
    assert.equal(b.V['Serial Number'], undefined);
  });
}

// Run with: node --test tests/spec-search.test.mjs
// Loads the REAL itemSearchText out of index.html (no copy) and proves the device search matches every characteristic
// (CPU, GPU, RAM, storage, screen, IMEI, connection...) the same way the tables do (every word is a substring), never throws,
// and still matches every field that was searchable before.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, '..', 'index.html'), 'utf8');
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
const ctx = vm.createContext({});
vm.runInContext(fnBlock('itemSearchText'), ctx);
const text = (i) => ctx.itemSearchText(i);
// same rule the tables use: every whitespace-separated word must be a substring
const hit = (i, q) => { const t = text(i).toLowerCase(); return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => t.includes(w)); };

const pc = { name: 'ASUS ROG Zephyrus S GX531GV', kind: 'PC', buyer: 'Simon Stuart', seller: 'Kijiji Seller', tradeId: 'T-77', serial: 'ABC123XYZ',
  specs: { Color: 'Black', RAM: '16 GB', CPU: 'Intel Core i7-9750H', GPU: 'NVIDIA RTX 2060 + Intel UHD', Storage: '1 TB NVME', Screen: '15.6 / 144 Hz', 'Original charger': 'Yes' } };
const phone = { name: 'iPhone 13', kind: 'Phone', specs: { Color: 'Blue', Storage: '256 GB', 'Original box': 'Yes', IMEI: '356789012345678' } };
const acc = { name: 'Logitech C920', kind: 'Accessory', type: 'Webcam', specs: { Type: 'Webcam', Connection: 'USB wireless dongle', Specs: '1080p' } };

test('PC is found by CPU, GPU, RAM, storage and screen characteristics', () => {
  for (const q of ['i7', 'rtx', '2060', 'nvidia', '16gb', '16 gb', '144hz', '144 hz', '1tb', 'nvme', '15.6', 'black']) assert.ok(hit(pc, q), q);
});
test('phone is found by IMEI fragment and storage', () => {
  assert.ok(hit(phone, '5678'));
  assert.ok(hit(phone, '256gb'));
  assert.ok(hit(phone, '256 gb'));
});
test('accessory is found by connection and spec text', () => {
  assert.ok(hit(acc, 'wireless'));
  assert.ok(hit(acc, '1080p'));
  assert.ok(hit(acc, 'webcam'));
});
test('several words all have to match', () => {
  assert.ok(hit(pc, 'i7 rtx'));
  assert.ok(hit(pc, 'i7 16gb 144hz'));
  assert.ok(!hit(pc, 'i7 3060'));
  assert.ok(!hit(phone, 'i7'));
});
test('a value that is not there does not match', () => {
  assert.ok(!hit(pc, 'ryzen'));
  assert.ok(!hit(pc, '32gb'));
});
test('everything that was searchable before still is', () => {
  for (const q of ['zephyrus', 'pc', 'simon', 'kijiji', 't-77', 'abc123']) assert.ok(hit(pc, q), q);
});
test('spec key names are not added as words (so "cpu" does not match every PC)', () => {
  assert.ok(!hit({ name: 'x', kind: 'PC', specs: { CPU: 'Ryzen 5' } }, 'cpu'));
});
test('never throws on null, odd or partial input', () => {
  assert.equal(text(null), '');
  assert.equal(text(undefined), '');
  assert.equal(text('a string'), '');
  assert.equal(text({}), '');
  assert.doesNotThrow(() => text({ name: 'A', specs: null }));
  assert.doesNotThrow(() => text({ name: 'A', specs: { RAM: 16, Storage: 512, X: null, Y: undefined, Z: '' } }));
  assert.ok(hit({ name: 'A', specs: { RAM: 16, Storage: 512 } }, '512'));
  assert.doesNotThrow(() => text({ name: { toString() { throw new Error('boom'); } } }));
});
test('output is lowercase and does not change the item', () => {
  const copy = JSON.stringify(pc);
  assert.equal(text(pc), text(pc).toLowerCase());
  assert.equal(JSON.stringify(pc), copy);
});
test('index.html wires it into the items table, stock table and command palette', () => {
  assert.ok(/text:r=>\[r\.name,r\.kind,r\.buyer,r\.seller,r\.notes,r\.condition,r\.tradeId\]\.join\(' '\)\+' '\+itemSearchText\(r\)/.test(html));
  assert.ok(/s\.stock\},text:r=>\[r\.name,r\.kind,r\.seller,r\.condition,r\.notes,r\.tradeId\]\.join\(' '\)\+' '\+itemSearchText\(r\)/.test(html));
  assert.ok(/toLowerCase\(\)\+' '\+itemSearchText\(i\);if\(ok\(t\)\)/.test(html));
});

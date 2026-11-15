// Run with: node --test tests/palette-search.test.mjs
// Loads the REAL search engine (the PALSEARCH block) out of index.html and checks: any field is searchable (price, CPU, GPU,
// notes, dates, other tabs), typos give a "Did you mean" and the likely results, nothing mutates the data, nothing throws.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, '..', 'index.html'), 'utf8');
const block = html.match(/\/\* PALSEARCH:START[\s\S]*?\/\* PALSEARCH:END \*\//)[0];
function fnBlock(name) {
  const start = html.indexOf('function ' + name + '(');
  let i = html.indexOf('{', html.indexOf(')', start)), d = 0;
  for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (d === 0) return html.slice(start, i + 1); } }
  throw new Error(name);
}
const opened = [];
const ctx = vm.createContext({ console, opened, store: {}, openDetail: (id) => opened.push(id), go: (v) => opened.push('go:' + v),
  fd: (d) => (d ? d.toISOString().slice(0, 10) : '—'), M: (n) => '$' + n, SM: (n) => '$' + n, kindWord: (k) => k,
  cmdList: () => [{ g: 'Go to', t: 'Spending', a() {} }, { g: 'Go to', t: 'Reselling', a() {} }, { g: 'Actions', t: 'Switch theme (auto / light / dark)', a() {} }],
  MO: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] });
vm.runInContext(fnBlock('itemSearchText') + '\n' + block + '\nglobalThis.S=palSearch;globalThis.E=palEdit;', ctx);
const S = ctx.S;

const pc = (n, cpu, gpu, buy, extra = {}) => ({ id: 'i' + n, kind: 'PC', name: 'Laptop ' + n, buyPrice: buy, buyDate: new Date(2026, 9, 3), sold: false, notes: extra.notes || null, seller: 'Kijiji', buyer: null,
  specs: { Color: 'Black', RAM: '16GB', CPU: cpu, GPU: gpu, Storage: '512 GB NVME' }, ...extra });
const D = {
  items: [pc(1, 'Intel Core i7-9750H', 'NVIDIA RTX 2060', 650, { notes: 'needs new charger' }), pc(2, 'AMD Ryzen 5 5600H', 'GTX 1650', 1200),
    pc(3, 'Intel Core i5-10300H', 'GTX 1650 Ti', 480), pc(4, 'Intel Core i5-11400H', 'RTX 3050', 700), pc(5, 'Intel Core i3', 'UHD', 300),
    { id: 'i6', kind: 'Phone', name: 'iPhone 13', buyPrice: 400, sold: true, sellPrice: 520, profit: 120, sellDate: new Date(2026, 10, 2), buyer: 'Simon', specs: { Storage: '256', IMEI: '356789012345678' } }],
  expenses: [{ id: 'e1', item: 'Coffee', place: 'Tim Hortons', category: 'Food', payment: 'Visa', amount: 4.75, date: new Date(2026, 10, 1), notes: 'with Sam' }],
  investments: [{ id: 'v1', portfolio: 'TFSA', value: 734.02, flow: 50, date: new Date(2026, 9, 1), type: 'Deposit', notes: null }],
};
const raw = { Owed: { rows: [{ Name: 'Marcus', Amount: 250, Reason: 'GPU deposit' }] }, Trades: { rows: [] } };
const titles = (r) => r.list.map((x) => x.t);
const snap = JSON.stringify([D, raw]);

test('searches any field: price, GPU, CPU, notes, buyer, place, date, IMEI, other tabs', () => {
  assert.ok(titles(S('1200', D, raw)).includes('Laptop 2'));
  assert.ok(titles(S('$1,200', D, raw)).includes('Laptop 2'));
  assert.ok(titles(S('rtx 2060', D, raw)).includes('Laptop 1'));
  assert.ok(titles(S('ryzen', D, raw)).includes('Laptop 2'));
  assert.ok(titles(S('charger', D, raw)).includes('Laptop 1'));
  assert.ok(titles(S('simon', D, raw)).includes('iPhone 13'));
  assert.ok(titles(S('tim hortons', D, raw)).includes('Coffee'));
  assert.ok(titles(S('sam', D, raw)).includes('Coffee'));
  assert.ok(titles(S('5678', D, raw)).includes('iPhone 13'));
  assert.ok(titles(S('nov 2', D, raw)).includes('iPhone 13'));
  assert.ok(titles(S('734.02', D, raw)).includes('TFSA'));
  assert.ok(titles(S('marcus', D, raw)).includes('Marcus'));
  assert.ok(titles(S('deposit', D, raw)).includes('Marcus'));
});
test('field names work as words (cpu finds rows that have a CPU)', () => {
  assert.ok(titles(S('cpu', D, raw)).includes('Laptop 3'));
  assert.ok(titles(S('notes', D, raw)).includes('Laptop 1'));
});
test('typo: "cou" offers CPU and shows its results', () => {
  const r = S('cou', D, raw);
  assert.equal(r.did && r.did.q, 'CPU');
  assert.ok(r.corrected);
  assert.ok(titles(r).includes('Laptop 3'));
});
test('typos in longer words and swapped letters are caught', () => {
  assert.equal(S('rzyen', D, raw).did.q, 'Ryzen');
  assert.equal(S('ryzne', D, raw).did.q, 'Ryzen');
  assert.equal(S('simom', D, raw).did.q, 'Simon');
  assert.ok(titles(S('simom', D, raw)).includes('iPhone 13'));
});
test('a correct word gets no suggestion; many results mean no nagging', () => {
  assert.equal(S('ryzen', D, raw).did, null);
  assert.equal(S('cpu', D, raw).did, null);
  assert.equal(S('1200', D, raw).did, null);
});
test('empty query lists the commands; no match is an empty list, not an error', () => {
  assert.ok(S('', D, raw).list.length >= 3);
  assert.equal(S('zzzzzzzz', D, raw).list.length, 0);
});
test('every word has to match', () => {
  assert.ok(!titles(S('ryzen 2060', D, raw)).includes('Laptop 2'));
});
test('edit distance counts a swap as one slip and stops early', () => {
  assert.equal(ctx.E('cpu', 'cou', 2), 1);
  assert.equal(ctx.E('ryzne', 'ryzen', 2), 1);
  assert.ok(ctx.E('abc', 'xyzxyz', 1) > 1);
});
test('missing data, odd rows and a missing raw never throw, and nothing is changed', () => {
  assert.doesNotThrow(() => S('x', { items: [null, {}], expenses: [{}], investments: [] }, null));
  assert.doesNotThrow(() => S('cou', { items: [], expenses: [], investments: [] }, { Owed: { rows: [null, 5, {}] } }));
  S('cou', D, raw);
  assert.equal(JSON.stringify([D, raw]), snap);
});
test('picking a row runs its action', () => {
  S('ryzen', D, raw).list[0].a();
  S('marcus', D, raw).list[0].a();
  assert.deepEqual(opened, ['i2', 'go:owed']);
});

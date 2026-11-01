// Run with: node tests/menu-status.test.mjs
// Loads the REAL menuStatus (and the owed helpers it uses) out of index.html, then checks the "Log an entry" status rules:
// loans and deposits are pending or overdue by their date, purchase/sale tabs flag a missing price or a repeated Row ID,
// Expenses flags a blank or repeated Row ID only when the sheet has that column, spare rows and missing tabs are ignored,
// counts are true while the item list is capped at 8, the input is never changed, and nothing ever throws.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');

function constLine(name) {
  const m = html.match(new RegExp('^const ' + name + '\\s*=.*$', 'm'));
  if (!m) throw new Error('const ' + name + ' not found in index.html');
  return m[0];
}
function fnBlock(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in index.html');
  let i = html.indexOf('{', html.indexOf(')', start)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
// pd spans two lines in index.html, so take it up to the next const
const pdStart = html.indexOf('const pd=');
const pdSrc = html.slice(pdStart, html.indexOf('\nconst rel=', pdStart));

const src = [
  ...['nf0', 'nf2', 'mny', 'DAY', 'sod', 'diffD', 'num', 'owedStr'].map(constLine),
  pdSrc,
  'const TODAY=sod(new Date(2026,9,31));',
  fnBlock('owedModel'), fnBlock('owedDue'), fnBlock('menuStatus'),
  'this.menuStatus=menuStatus;'
].join('\n');
const ctx = vm.createContext({ Intl, Math, Date, Object, Array, String, Number, Boolean, JSON });
vm.runInContext(src, ctx);
const T = new Date(2026, 9, 31);
// results are plain values, so a JSON round trip lets strict comparisons ignore the sandbox's own Object prototype
const ms = raw => JSON.parse(JSON.stringify(ctx.menuStatus(raw, T)));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

const owedTab = rows => ({ Owed: { headers: ['Person', 'Type', 'Total Amount', 'Amount Paid', 'Item / Device', 'Date Out', 'Due Date', 'Status', 'Row ID'], rows: rows.map((r, i) => ({ _row: i + 2, ...r })) } });
const loan = (Person, extra = {}) => ({ Person, Type: 'Loan', 'Total Amount': 100, 'Amount Paid': 0, ...extra });
const dep = (Person, extra = {}) => ({ Person, Type: 'Deposit', 'Total Amount': 500, 'Amount Paid': 80, ...extra });

test('no Owed tab and no data gives an empty result', () => {
  assert.deepEqual(ms({}), {});
  assert.deepEqual(ms({ Expenses: { headers: [], rows: [] } }), {});
});

test('open loan is pending; an open loan past its date makes the row overdue', () => {
  let r = ms(owedTab([loan('Sam', { 'Due Date': '2026-11-10' })]));
  assert.equal(r.loan.status, 'pending'); assert.equal(r.loan.count, 1);
  r = ms(owedTab([loan('Sam', { 'Due Date': '2026-11-10' }), loan('Dev', { 'Due Date': '2026-10-20' })]));
  assert.equal(r.loan.status, 'overdue'); assert.equal(r.loan.count, 2);
  assert.match(r.loan.items[0].text, /^Dev/, 'most overdue listed first');
  assert.match(r.loan.items[0].text, /overdue/);
  assert.equal(r.loan.items[0].view, 'owed');
});

test('closed loans are not flagged', () => {
  const r = ms(owedTab([loan('Sam', { Status: 'Returned', 'Due Date': '2026-10-01' })]));
  assert.equal(r.loan, undefined);
});

test('deposit past pickup date is overdue and deposits sort by pickup date', () => {
  let r = ms(owedTab([dep('Ana', { 'Item / Device': 'RTX 3060 PC', 'Due Date': '2026-10-28' })]));
  assert.equal(r.dep.status, 'overdue');
  assert.match(r.dep.items[0].text, /held on RTX 3060 PC/);
  r = ms(owedTab([dep('Later', { 'Due Date': '2026-12-01' }), dep('Sooner', { 'Due Date': '2026-11-05' })]));
  assert.equal(r.dep.status, 'pending');
  assert.match(r.dep.items[0].text, /^Sooner/);
});

test('loans and deposits do not mix', () => {
  const r = ms(owedTab([loan('Sam'), dep('Ana')]));
  assert.equal(r.loan.count, 1); assert.equal(r.dep.count, 1);
});

const devTab = (name, price, rows, withPriceCol = true) => ({ headers: ['Row ID', name, ...(withPriceCol ? [price] : [])], rows: rows.map((x, i) => ({ _row: i + 2, ...x })) });

test('missing price is an issue on purchase and sale tabs', () => {
  const r = ms({
    BoughtPCs: devTab('PC model', 'Purchase Price', [{ 'PC model': 'Dell', 'Purchase Price': '' }, { 'PC model': 'Lenovo', 'Purchase Price': '$250' }]),
    SoldPhones: devTab('Device Label', 'Sale Price', [{ 'Device Label': 'Pixel 7', 'Sale Price': 'abc' }])
  });
  assert.equal(r.bpc.status, 'issue'); assert.equal(r.bpc.count, 1);
  assert.match(r.bpc.items[0].text, /^Dell — missing price/);
  assert.equal(r.bpc.items[0].view, 'data');
  assert.equal(r.sphone.count, 1);
  assert.equal(r.bphone, undefined);
});

test('a tab without the price column never raises a false alarm', () => {
  const r = ms({ BoughtAccess: devTab('Model', 'Purchase Price', [{ Model: 'Mouse' }], false) });
  assert.equal(r.bacc, undefined);
});

test('spare rows and null rows are ignored', () => {
  const r = ms({ SoldPCs: devTab('Device', 'Sale Price', [{ Device: '', 'Sale Price': '' }, null, { Device: 'X', 'Sale Price': 99 }]) });
  assert.equal(r.spc, undefined);
});

test('a repeated Row ID is an issue, a blank one is not (device tabs)', () => {
  const r = ms({ BoughtPhones: devTab('Phone Model', 'Purchased Price', [
    { 'Row ID': 'A1', 'Phone Model': 'iPhone', 'Purchased Price': 100 },
    { 'Row ID': 'A1', 'Phone Model': 'Pixel', 'Purchased Price': 90 },
    { 'Row ID': '', 'Phone Model': 'Moto', 'Purchased Price': 50 }]) });
  assert.equal(r.bphone.count, 2);
  assert.ok(r.bphone.items.every(i => /duplicate Row ID A1/.test(i.text)));
});

test('Expenses: blank and repeated Row IDs are issues only when the column exists', () => {
  const withCol = { Expenses: { headers: ['Row ID', 'Item Purchased', 'Amount'], rows: [
    { _row: 2, 'Row ID': 'E1', 'Item Purchased': 'Gas', Amount: 40 },
    { _row: 3, 'Row ID': '', 'Item Purchased': 'Lunch', Amount: 12 },
    { _row: 4, 'Row ID': 'E1', 'Item Purchased': 'Coffee', Amount: 5 },
    { _row: 5, 'Row ID': '', 'Item Purchased': '', Amount: '' }] } };
  const r = ms(withCol);
  assert.equal(r.exp.status, 'issue'); assert.equal(r.exp.count, 3);
  const noCol = { Expenses: { headers: ['Item Purchased', 'Amount'], rows: [{ _row: 2, 'Item Purchased': 'Gas', Amount: 40 }] } };
  assert.equal(ms(noCol).exp, undefined);
});

test('count is the true total while items are capped at 8', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ 'Row ID': 'R' + i, 'Item Purchased': 'x' + i, Amount: 1 })).map(r => ({ ...r, 'Row ID': '' }));
  const r = ms({ Expenses: { headers: ['Row ID', 'Item Purchased', 'Amount'], rows: rows.map((x, i) => ({ _row: i + 2, ...x })) } });
  assert.equal(r.exp.count, 20); assert.equal(r.exp.items.length, 8);
});

test('investment never gets a status key', () => {
  assert.equal(ms({ Expenses: { headers: ['Row ID'], rows: [] } }).inv, undefined);
});

test('the input is never changed', () => {
  const raw = { ...owedTab([loan('Sam', { 'Due Date': '2026-10-01' })]), BoughtPCs: devTab('PC model', 'Purchase Price', [{ 'PC model': 'Dell', 'Purchase Price': '' }]) };
  const before = JSON.stringify(raw);
  ms(raw);
  assert.equal(JSON.stringify(raw), before);
});

test('garbage input never throws', () => {
  for (const g of [undefined, null, 0, 'x', [], { Owed: 5 }, { Owed: { rows: [null, 1, 'x'] } }, { Expenses: { rows: 'no' } }, { BoughtPCs: { rows: [null, undefined, 7] } }, { SoldPCs: 3 }]) {
    assert.doesNotThrow(() => ms(g));
    assert.equal(typeof ms(g), 'object');
  }
});

console.log(`\n${passed} passed`);

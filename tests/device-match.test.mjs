// Run with: node --test tests/device-match.test.mjs
// Loads the REAL loadViaScript and matchDeviceRows out of index.html (no copies) into a sandbox with stubs, and proves:
//  - matchDeviceRows finds exactly ONE purchase row (and, for a sold device, exactly ONE sale row), otherwise {purchase:null,sale:null,ok:false}
//  - accessories match the PURCHASE row only (type + brand/model + price + date + seller, exactly one row each side), and a missing tab / null input never throws
//  - loadViaScript keeps the six optional entry tabs when the script sends them, and returns exactly the old five keys when it does not
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
function constLine(name) { const m = html.match(new RegExp('^const ' + name + '=.*$', 'm')); if (!m) throw new Error(name + ' not found'); return m[0]; }
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
// async functions start with "async function", so take that prefix too
const asyncFn = name => 'async ' + fnBlock(name);

let payload = null;   // what the stubbed script link answers; set per test
const ctx = vm.createContext({
  LS: { get: () => '' },
  fetch: async () => ({ ok: true, json: async () => payload })
});
vm.runInContext([
  constLine('TABS'),
  constLine('EXTRA_TABS'),
  asyncFn('loadViaScript'),
  fnBlock('matchDeviceRows'),
  'globalThis.__t={loadViaScript,matchDeviceRows,TABS};'
].join('\n'), ctx);
const { loadViaScript, matchDeviceRows, TABS } = ctx.__t;

// vm results have another realm's prototypes, so compare plain JSON copies
const plain = x => JSON.parse(JSON.stringify(x));
const FAIL = { purchase: null, sale: null, ok: false };

const LABEL = 'Samsung S24 (Purple) - Bought $400';
const phone = (over = {}) => Object.assign({ kind: 'Phone', sold: true, label: LABEL, specs: { IMEI: 'R3CX30MLB9W' } }, over);

function makeBasePayload() {
  const tab = name => ({ sheet: name, headers: [], rows: [] });
  return { ok: true, tabs: { Expenses: tab('Expenses'), Phones: tab('Master Inventory'), PCs: tab('PCs'), Accessories: tab('PnA'), Investments: tab('Investment Tracking Sheet') } };
}

/* ---------------- matchDeviceRows ---------------- */

test('exact match, sold phone: purchase and sale both found, with tab names, Row IDs and the same row objects', () => {
  const pRow = { 'Row ID': 'rp1', 'Serial Number': 'R3CX30MLB9W' };
  const sRow = { 'Row ID': 'rs1', 'Device Label': LABEL };
  const raw = { BoughtPhones: { sheet: 'Form Responses - Bought', rows: [pRow] }, SoldPhones: { sheet: 'Form Responses - Sold', rows: [sRow] } };
  const res = matchDeviceRows(phone(), raw);
  assert.equal(res.ok, true);
  assert.equal(res.purchase.tab, 'Form Responses - Bought');
  assert.equal(res.purchase.rowId, 'rp1');
  assert.equal(res.purchase.row, pRow);
  assert.equal(res.sale.tab, 'Form Responses - Sold');
  assert.equal(res.sale.rowId, 'rs1');
  assert.equal(res.sale.row, sRow);
});

test('exact match, unsold phone: purchase found, sale is null, ok is true (sold tab is not even read)', () => {
  const pRow = { 'Row ID': 'rp2', 'Serial Number': 'R3CX30MLB9W' };
  const raw = { BoughtPhones: { sheet: 'Form Responses - Bought', rows: [pRow] }, SoldPhones: { sheet: 'Form Responses - Sold', rows: [{ 'Device Label': LABEL }] } };
  const res = matchDeviceRows(phone({ sold: false }), raw);
  assert.equal(res.ok, true);
  assert.equal(res.purchase.row, pRow);
  assert.equal(res.sale, null);
});

test('serial and label are matched ignoring case and extra spaces', () => {
  const pRow = { 'Row ID': 'rp3', 'Serial Number': '  r3cx  30ml b9w ' };
  const sRow = { 'Row ID': 'rs3', 'Device Label': 'samsung   s24  (purple) -   bought $400' };
  const raw = { BoughtPhones: { sheet: 'B', rows: [pRow] }, SoldPhones: { sheet: 'S', rows: [sRow] } };
  const res = matchDeviceRows(phone({ label: ' Samsung S24 (Purple)  - Bought $400 ' }), raw);
  assert.equal(res.ok, true);
  assert.equal(res.purchase.row, pRow);
  assert.equal(res.sale.row, sRow);
});

test('duplicate serial in the Bought tab: ok false, nothing returned', () => {
  const raw = { BoughtPhones: { sheet: 'B', rows: [{ 'Row ID': 'a', 'Serial Number': 'R3CX30MLB9W' }, { 'Row ID': 'b', 'Serial Number': 'r3cx30mlb9w' }] } };
  assert.deepEqual(plain(matchDeviceRows(phone({ sold: false }), raw)), FAIL);
});

test('missing serial: no IMEI, blank IMEI, or a serial that is not in the Bought tab all give ok false', () => {
  const raw = { BoughtPhones: { sheet: 'B', rows: [{ 'Row ID': 'a', 'Serial Number': 'R3CX30MLB9W' }, { 'Row ID': 'b', 'Serial Number': null }] } };
  assert.deepEqual(plain(matchDeviceRows(phone({ sold: false, specs: {} }), raw)), FAIL);
  assert.deepEqual(plain(matchDeviceRows(phone({ sold: false, specs: { IMEI: '   ' } }), raw)), FAIL);
  assert.deepEqual(plain(matchDeviceRows(phone({ sold: false, specs: { IMEI: null } }), raw)), FAIL);
  assert.deepEqual(plain(matchDeviceRows(phone({ sold: false, specs: { IMEI: 'SOMETHINGELSE' } }), raw)), FAIL);
});

test('sold device with no sale row: ok false and the purchase is NOT returned either (all or nothing)', () => {
  const raw = { BoughtPhones: { sheet: 'B', rows: [{ 'Row ID': 'a', 'Serial Number': 'R3CX30MLB9W' }] }, SoldPhones: { sheet: 'S', rows: [{ 'Device Label': 'Some other phone' }] } };
  assert.deepEqual(plain(matchDeviceRows(phone(), raw)), FAIL);
});

test('sold device whose label appears in TWO sale rows: ok false', () => {
  const raw = { BoughtPhones: { sheet: 'B', rows: [{ 'Row ID': 'a', 'Serial Number': 'R3CX30MLB9W' }] }, SoldPhones: { sheet: 'S', rows: [{ 'Row ID': 's1', 'Device Label': LABEL }, { 'Row ID': 's2', 'Device Label': LABEL }] } };
  assert.deepEqual(plain(matchDeviceRows(phone(), raw)), FAIL);
});

test('sold device with a blank label, or with the sold tab missing: ok false', () => {
  const bought = { sheet: 'B', rows: [{ 'Row ID': 'a', 'Serial Number': 'R3CX30MLB9W' }] };
  assert.deepEqual(plain(matchDeviceRows(phone({ label: '  ' }), { BoughtPhones: bought, SoldPhones: { sheet: 'S', rows: [{ 'Device Label': '' }] } })), FAIL);
  assert.deepEqual(plain(matchDeviceRows(phone(), { BoughtPhones: bought })), FAIL);
});

test('accessory: no reliable shared key, so ok false even when the entry tabs look like a match', () => {
  const raw = {
    BoughtAccess: { sheet: 'Bought Access - Form', rows: [{ 'Row ID': 'x1', 'Serial Number': 'ACC12345', Model: 'Alloy Origins Core' }] },
    SoldAccess: { sheet: 'Sold Access - Form', rows: [{ 'Row ID': 'x2', 'Item Sold': 'Keyboard HyperX Alloy Origins Core (Black) - $26.14' }] }
  };
  const item = { kind: 'Accessory', sold: true, label: 'Keyboard HyperX Alloy Origins Core (Black) - $26.14', serial: 'ACC12345', specs: { Type: 'Keyboard' } };
  assert.deepEqual(plain(matchDeviceRows(item, raw)), FAIL);
  assert.deepEqual(plain(matchDeviceRows(Object.assign({}, item, { sold: false }), raw)), FAIL);
});

test('PC: matches when the item carries a serial (sale column is "Device"); a PC with no serial fails', () => {
  const pRow = { 'Row ID': 'pc-p', 'Serial Number': '5cd1234 xyz' };
  const sRow = { 'Row ID': 'pc-s', Device: 'HP EliteBook 840 G5 (Black) • $350 • Sam • [ABC123]' };
  const raw = { BoughtPCs: { sheet: 'Form Responses - PCs', rows: [pRow] }, SoldPCs: { sheet: 'Form Responses - Sold PCs', rows: [sRow] } };
  const item = { kind: 'PC', sold: true, label: 'HP EliteBook 840 G5 (Black) • $350 • Sam • [ABC123]', serial: '5CD1234XYZ', specs: {} };
  const res = matchDeviceRows(item, raw);
  assert.equal(res.ok, true);
  assert.equal(res.purchase.tab, 'Form Responses - PCs');
  assert.equal(res.purchase.row, pRow);
  assert.equal(res.sale.tab, 'Form Responses - Sold PCs');
  assert.equal(res.sale.row, sRow);
  assert.deepEqual(plain(matchDeviceRows({ kind: 'PC', sold: false, label: item.label, specs: {} }, raw)), FAIL);
});

test('older script / bad input: raw without the new keys, null raw, null item, non-array rows, null rows all give ok false and never throw', () => {
  assert.deepEqual(plain(matchDeviceRows(phone(), {})), FAIL);
  assert.deepEqual(plain(matchDeviceRows(phone(), null)), FAIL);
  assert.deepEqual(plain(matchDeviceRows(null, {})), FAIL);
  assert.deepEqual(plain(matchDeviceRows(undefined, undefined)), FAIL);
  assert.deepEqual(plain(matchDeviceRows(phone(), { BoughtPhones: { sheet: 'B', rows: 'nope' } })), FAIL);
  assert.equal(matchDeviceRows(phone({ sold: false }), { BoughtPhones: { sheet: 'B', rows: [null, 5, 'x', { 'Serial Number': 'R3CX30MLB9W' }] } }).ok, true);   // junk rows are skipped, the one real row still matches
});

test('a matched row with a blank or missing Row ID still matches, with rowId null', () => {
  const raw = { BoughtPhones: { sheet: 'B', rows: [{ 'Serial Number': 'R3CX30MLB9W' }] }, SoldPhones: { sheet: 'S', rows: [{ 'Row ID': '   ', 'Device Label': LABEL }] } };
  const res = matchDeviceRows(phone(), raw);
  assert.equal(res.ok, true);
  assert.equal(res.purchase.rowId, null);
  assert.equal(res.sale.rowId, null);
});

test('inputs are not changed by a match (success or failure)', () => {
  const raw = { BoughtPhones: { sheet: 'B', rows: [{ 'Row ID': 'p', 'Serial Number': 'R3CX30MLB9W' }] }, SoldPhones: { sheet: 'S', rows: [{ 'Row ID': 's', 'Device Label': LABEL }] } };
  const item = phone();
  const before = JSON.stringify([raw, item]);
  matchDeviceRows(item, raw);
  matchDeviceRows(phone({ specs: { IMEI: 'NOPE' } }), raw);
  assert.equal(JSON.stringify([raw, item]), before);
});

/* ---------------- loadViaScript keeps the six optional tabs ---------------- */

const EXTRA = ['BoughtPhones', 'BoughtPCs', 'BoughtAccess', 'SoldPhones', 'SoldPCs', 'SoldAccess'];

test('loader: when the script sends the six entry tabs they are kept next to the five required ones', async () => {
  const p = makeBasePayload();
  EXTRA.forEach(k => { p.tabs[k] = { sheet: 'Sheet ' + k, headers: ['Serial Number'], rows: [{ id: k + '-1' }] }; });
  payload = p;
  const out = await loadViaScript('https://script.example/exec', TABS);
  ['Expenses', 'Phones', 'PCs', 'Accessories', 'Investments'].forEach(k => assert.ok(out[k], k + ' still loaded'));
  EXTRA.forEach(k => {
    assert.equal(out[k].sheet, 'Sheet ' + k);
    assert.deepEqual(plain(out[k].headers), ['Serial Number']);
    assert.equal(out[k].rows.length, 1);
    assert.equal(out[k].rows[0].id, k + '-1');
  });
});

test('loader: an older script (no entry tabs) gives exactly the five old keys, as before', async () => {
  payload = makeBasePayload();
  const out = await loadViaScript('https://script.example/exec', TABS);
  assert.deepEqual(Object.keys(out).sort(), ['Accessories', 'Expenses', 'Investments', 'PCs', 'Phones']);
});

test('loader: an entry tab flagged missing, or without a rows array, is skipped quietly', async () => {
  const p = makeBasePayload();
  p.tabs.BoughtPhones = { missing: true };
  p.tabs.BoughtPCs = { sheet: 'x' };
  p.tabs.SoldPhones = { sheet: 'x', rows: 'invalid' };
  p.tabs.BoughtAccess = { sheet: 'Bought Access - Form', headers: [], rows: [] };
  payload = p;
  const out = await loadViaScript('https://script.example/exec', TABS);
  assert.equal(out.BoughtPhones, undefined);
  assert.equal(out.BoughtPCs, undefined);
  assert.equal(out.SoldPhones, undefined);
  assert.ok(out.BoughtAccess);
});

test('loader: a missing or broken REQUIRED tab still throws, exactly as before', async () => {
  let p = makeBasePayload(); delete p.tabs.Phones; payload = p;
  await assert.rejects(() => loadViaScript('https://script.example/exec', TABS));
  p = makeBasePayload(); p.tabs.Expenses = { missing: true }; payload = p;
  await assert.rejects(() => loadViaScript('https://script.example/exec', TABS));
  p = makeBasePayload(); delete p.tabs.PCs.rows; payload = p;
  await assert.rejects(() => loadViaScript('https://script.example/exec', TABS));
});

// ---- accessories: the PURCHASE row only, matched on type + brand/model + price + date + seller together ----
const accItem = (over = {}) => Object.assign({ kind: 'Accessory', name: 'Samsung Odyssey G3', type: 'Monitor', sold: false, buyPrice: 61.79, buyDate: new Date(2026, 6, 3), seller: 'Dang Hoang', specs: { Type: 'Monitor' } }, over);
const accRaw = () => ({
  Accessories: { sheet: 'PnA', rows: [
    { 'Item ID': 'ACC-00001', 'Item Type': 'Monitor', Brand: 'Acer ', Model: 'G237HL ', 'Purchase Price': '$19.01', 'Date Purchased': '2026-07-03', 'Bought From': 'Dang Hoang' },
    { 'Item ID': 'ACC-00002', 'Item Type': 'Monitor', Brand: 'Samsung', Model: 'Odyssey G3 ', 'Purchase Price': '$61.79', 'Date Purchased': '2026-07-03', 'Bought From': 'Dang Hoang' }
  ] },
  BoughtAccess: { sheet: 'Bought Access - Form', rows: [
    { 'Row ID': 'aa01', 'Item Type': 'Monitor', 'Serial Number': 'Acer ', Model: 'G237HL ', 'Purchase Price': 19.01, 'Date Purchased': { $date: '2026-07-03' }, 'Bought From': 'Dang Hoang' },
    { 'Row ID': 'aa02', 'Item Type': 'Monitor', 'Serial Number': 'Samsung', Model: 'Odyssey G3 ', 'Purchase Price': 61.79, 'Date Purchased': { $date: '2026-07-03' }, 'Bought From': 'Dang Hoang' }
  ] }
});

test('accessory: the real monitor example matches ONE purchase row, and never a sale row', () => {
  const raw = accRaw();
  const res = matchDeviceRows(accItem(), raw);
  assert.equal(res.ok, true);
  assert.equal(res.sale, null);
  assert.equal(res.purchase.tab, 'Bought Access - Form');
  assert.equal(res.purchase.rowId, 'aa02');
  assert.equal(res.purchase.row, raw.BoughtAccess.rows[1]);
  const sold = matchDeviceRows(accItem({ sold: true }), raw);
  assert.equal(sold.ok, true);
  assert.equal(sold.sale, null, 'a sold accessory still never matches a sale row');
});

test('accessory: a blank Row ID still matches (rowId null), so the drawer can offer Fill missing IDs', () => {
  const raw = accRaw(); raw.BoughtAccess.rows[1]['Row ID'] = '';
  const res = matchDeviceRows(accItem(), raw);
  assert.equal(res.ok, true);
  assert.equal(res.purchase.rowId, null);
});

test('accessory: ISO text dates and a different date format on the sheet side both work, an unreadable date fails', () => {
  const raw = accRaw(); raw.BoughtAccess.rows[1]['Date Purchased'] = '2026-07-03';
  assert.equal(matchDeviceRows(accItem(), raw).ok, true);
  raw.BoughtAccess.rows[1]['Date Purchased'] = '7/3/2026';
  assert.deepEqual(plain(matchDeviceRows(accItem(), raw)), FAIL);
});

test('accessory: ANY one of price, date, seller, type or name disagreeing means ok false', () => {
  for (const over of [{ buyPrice: 61.8 }, { buyDate: new Date(2026, 6, 4) }, { seller: 'Someone Else' }, { type: 'Mouse', specs: { Type: 'Mouse' } }, { name: 'Samsung Odyssey G5' }]) {
    assert.deepEqual(plain(matchDeviceRows(accItem(over), accRaw())), FAIL, JSON.stringify(over));
  }
});

test('accessory: two identical purchase rows, or two identical inventory rows, means ok false (never guess)', () => {
  const dupBought = accRaw(); dupBought.BoughtAccess.rows.push(Object.assign({}, dupBought.BoughtAccess.rows[1], { 'Row ID': 'aa99' }));
  assert.deepEqual(plain(matchDeviceRows(accItem(), dupBought)), FAIL);
  const dupInv = accRaw(); dupInv.Accessories.rows.push(Object.assign({}, dupInv.Accessories.rows[1], { 'Item ID': 'ACC-00099' }));
  assert.deepEqual(plain(matchDeviceRows(accItem(), dupInv)), FAIL);
});

test('accessory: a missing key field on the item, or a missing tab, fails without throwing', () => {
  for (const over of [{ buyPrice: null }, { buyDate: null }, { seller: null }, { name: '' }, { type: undefined, specs: {} }]) {
    assert.deepEqual(plain(matchDeviceRows(accItem(over), accRaw())), FAIL, JSON.stringify(over));
  }
  const noBought = accRaw(); delete noBought.BoughtAccess;
  assert.deepEqual(plain(matchDeviceRows(accItem(), noBought)), FAIL);
  const noInv = accRaw(); delete noInv.Accessories;
  assert.deepEqual(plain(matchDeviceRows(accItem(), noInv)), FAIL);
});

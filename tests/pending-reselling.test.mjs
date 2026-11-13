// Run with: node --test tests/pending-reselling.test.mjs
// Loads the REAL "PENDING DEPOSITS" block and the profit helpers out of index.html and proves the Reselling tab rules:
//  - status shows Sold / Pending / In stock, and Sold and In stock pills keep their old class and text
//  - the "In stock" filter means available stock only; "Pending" shows only devices with an open deposit; sold devices never leak in
//  - cancelling (closing) a deposit returns the device to In stock; logging the sale turns it into Sold
//  - Pending is not a sale: profit / revenue helpers only read sold devices
//  - the screens are wired to the helpers, and the block still has no network or storage calls
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('/* ===== PENDING DEPOSITS START');
const b = html.indexOf('/* ===== PENDING DEPOSITS END ===== */');
assert.ok(a > 0 && b > a, 'pending deposits markers found');
const block = html.slice(a, b);
assert.ok(!/fetch|sheetCall|XMLHttpRequest|localStorage|sendBeacon|LS\./.test(block), 'block has no network, storage or write calls');

const soldLine = html.match(/^function soldItems\(D,kind\)\{.*\}$/m);
assert.ok(soldLine, 'soldItems found');

const ctx = vm.createContext({ Date, Math, JSON, Object, Array, String, Set });
vm.runInContext(block + soldLine[0] + '\nthis.api={applyPendingDeposits,itemStatus,itemStatusPill,statusFilterMatch,soldItems};', ctx);
const { applyPendingDeposits, itemStatus, itemStatusPill, statusFilterMatch, soldItems } = ctx.api;

let n = 0;
const item = o => Object.assign({ id: 'i' + n++, kind: 'Phone', name: 'Pixel 9 Pro', label: null, sold: false, buyPrice: 400, sellPrice: null, profit: null, buyDate: new Date(2026, 9, 1), age: 10, row: 2 + n }, o);
const dep = o => Object.assign({ id: 'D' + n++, row: 2 + n, name: 'Ali', device: 'Pixel 9 Pro', total: 500, paid: 100, balance: 400, dateIn: new Date(2026, 10, 1), pickup: new Date(2026, 10, 20), daysLeft: 8, overdue: false, open: true }, o);

test('status helper: Sold wins, then Pending, else In stock, with the old pill classes kept', () => {
  assert.deepEqual({ ...itemStatus({ sold: true, pending: true }) }, { key: 'sold', label: 'Sold', cls: 'good' });
  assert.deepEqual({ ...itemStatus({ sold: false, pending: true }) }, { key: 'pending', label: 'Pending', cls: 'pend' });
  assert.deepEqual({ ...itemStatus({ sold: false }) }, { key: 'stock', label: 'In stock', cls: 'warn' });
  assert.equal(itemStatusPill({ sold: true }), '<span class="pill good">Sold</span>');
  assert.equal(itemStatusPill({ sold: false }), '<span class="pill warn">In stock</span>');
  assert.equal(itemStatusPill({ sold: false, pending: true }), '<span class="pill pend">Pending</span>');
  assert.equal(itemStatusPill(null), '<span class="pill warn">In stock</span>');
});

test('filters: In stock = available only, Pending = open deposit only, All = everything', () => {
  const sold = item({ sold: true, profit: 50 }), held = item({ name: 'Galaxy S24' }), free = item({ name: 'iPhone 14' });
  applyPendingDeposits([sold, held, free], [dep({ device: 'Galaxy S24' })]);
  const list = [sold, held, free];
  const f = m => list.filter(i => statusFilterMatch(i, m)).map(i => i.name);
  assert.deepEqual(f('Pending'), ['Galaxy S24']);
  assert.deepEqual(f('Stock'), ['iPhone 14']);
  assert.deepEqual(f('Sold'), ['Pixel 9 Pro']);
  assert.equal(f('All').length, 3);
});

test('cancelling the deposit returns the device to In stock; completing the sale makes it Sold', () => {
  const it = item({ name: 'Galaxy S24' });
  applyPendingDeposits([it], [dep({ device: 'Galaxy S24' })]);
  assert.equal(itemStatus(it).key, 'pending');
  for (const closed of ['picked up', 'forfeited', 'refunded']) {
    applyPendingDeposits([it], [dep({ device: 'Galaxy S24', open: false, status: closed })]);
    assert.equal(itemStatus(it).key, 'stock', closed + ' => In stock');
    assert.equal(it.stage, 'IN STOCK');
  }
  applyPendingDeposits([it], [dep({ device: 'Galaxy S24' })]);
  assert.equal(itemStatus(it).key, 'pending');
  it.sold = true; it.sellPrice = 600; it.profit = 200;   // the normal Sold form
  applyPendingDeposits([it], [dep({ device: 'Galaxy S24' })]);
  assert.equal(itemStatus(it).key, 'sold');
  assert.equal(it.pending, false);
});

test('Pending is not a sale: profit helpers only see sold devices', () => {
  const held = item({ name: 'Galaxy S24', profit: 999, sellPrice: 999 });   // even stray numbers on an unsold row must not count
  const done = item({ sold: true, profit: 50, sellPrice: 450 });
  applyPendingDeposits([held, done], [dep({ device: 'Galaxy S24' })]);
  assert.deepEqual(soldItems({ items: [held, done] }, 'All').map(i => i.profit), [50]);
});

test('screens are wired to the helpers and the old inline Sold / In stock pill is gone', () => {
  assert.ok(!html.includes("${r.sold?'Sold':'In stock'}"), 'table pill replaced');
  assert.ok(!html.includes("${o.sold?'Sold':'In stock'}"), 'detail pill replaced');
  assert.ok(html.includes("['Pending','Pending']"), 'Pending filter button present');
  assert.ok(html.includes('statusFilterMatch(i,S.rstat)'), 'itemRows uses the filter helper');
  assert.ok(/\.pill\.pend\{/.test(html), 'Pending pill style present');
  const rs = html.slice(html.indexOf('function resellingStats'), html.indexOf('function inventoryStats'));
  assert.ok(!/pending/.test(rs), 'resellingStats never reads pending');
});

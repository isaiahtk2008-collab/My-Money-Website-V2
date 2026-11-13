// Run with: node --test tests/pending-deposits.test.mjs
// Loads the REAL "PENDING DEPOSITS" block out of index.html (no copies) and proves:
//  - an open deposit marks exactly one matching unsold device as pending (label first, then name), and nothing else about the device changes
//  - closed deposits (Picked Up, Forfeited, Refunded), sold devices, blank text and unknown text never mark anything
//  - two identical devices: the older purchase is taken first and the pair is reported as ambiguous; two deposits never claim the same device
//  - the device picker list leaves out sold and pending devices, groups by Phone / PC / Accessory, and writes the same text the matcher reads back
//  - bad input (null, wrong types, odd rows) never throws and never changes the input list's length
//  - normalize() and inventoryStats() are wired in additively (the old `stock` list is untouched)
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

const ctx = vm.createContext({ Date, Math, JSON, Object, Array, String, Set });
vm.runInContext(block + '\nthis.api={pdNorm,depositDeviceText,linkDepositsToItems,applyPendingDeposits,stockForDeposit};', ctx);
const { depositDeviceText, linkDepositsToItems, applyPendingDeposits, stockForDeposit } = ctx.api;

const plain = x => JSON.parse(JSON.stringify(x));
const D = (y, m, d) => new Date(y, m - 1, d);
let n = 0;
const item = o => Object.assign({ id: 'i' + n++, kind: 'Phone', name: 'Pixel 9 Pro', label: null, sold: false, buyPrice: 400, buyDate: D(2026, 10, 1), age: 10, row: 2 + n, status: 'IN INVENTORY' }, o);
const dep = o => Object.assign({ id: 'D' + n++, row: 2 + n, name: 'Ali', device: 'Pixel 9 Pro', total: 500, paid: 100, balance: 400, dateIn: D(2026, 11, 1), pickup: D(2026, 11, 20), daysLeft: 8, overdue: false, open: true }, o);

test('an open deposit marks the matching device pending and leaves its other fields alone', () => {
  const it = item({ label: 'Pixel 9 Pro (Black) - Bought $400' });
  const before = plain(it);
  const r = applyPendingDeposits([it], [dep({ id: 'D9', device: 'pixel 9 pro (black) - bought $400' })]);
  assert.equal(r.linked, 1);
  assert.equal(it.pending, true);
  assert.equal(it.stage, 'PENDING');
  assert.equal(it.pendingDep.id, 'D9');
  assert.equal(it.pendingDep.balance, 400);
  assert.equal(it.pendingDep.daysLeft, 8);
  for (const k of ['sold', 'status', 'buyPrice', 'sellPrice', 'profit', 'name', 'label', 'age']) assert.deepEqual(plain(it)[k], before[k], k + ' unchanged');
});

test('label match wins over name match; name is used when the device has no label', () => {
  const withLabel = item({ name: 'Galaxy S24', label: 'Galaxy S24 - Bought $420' });
  const noLabel = item({ name: 'Galaxy S24', label: null });
  applyPendingDeposits([withLabel, noLabel], [dep({ device: 'Galaxy S24 - Bought $420' })]);
  assert.equal(withLabel.pending, true);
  assert.equal(noLabel.pending, false);
  const only = item({ name: 'Acer Nitro N50-640', kind: 'PC' });
  applyPendingDeposits([only], [dep({ device: '  ACER   Nitro N50-640 ' })]);
  assert.equal(only.pending, true);
});

test('closed deposits, sold devices, blank and unknown text never mark anything', () => {
  const stock = item({ name: 'iPhone 15' });
  const sold = item({ name: 'iPhone 14', sold: true, status: 'SOLD' });
  const r = applyPendingDeposits([stock, sold], [
    dep({ device: 'iPhone 15', open: false }),   // Picked Up / Forfeited / Refunded
    dep({ device: 'iPhone 14' }),                // already sold
    dep({ device: '' }),
    dep({ device: 'something typed by hand' })
  ]);
  assert.equal(r.linked, 0);
  assert.equal(r.unmatched.length, 3);   // the closed one is not counted: only open deposits are looked at
  assert.equal(stock.pending, false);
  assert.equal(stock.stage, 'IN STOCK');
  assert.equal(sold.stage, 'SOLD');
  assert.equal(sold.pending, false);
});

test('cancelling a deposit returns the device to stock on the next read (state is derived, not stored)', () => {
  const it = item({ name: 'MacBook Air M1', kind: 'PC' });
  applyPendingDeposits([it], [dep({ device: 'MacBook Air M1' })]);
  assert.equal(it.stage, 'PENDING');
  applyPendingDeposits([it], [dep({ device: 'MacBook Air M1', open: false })]);
  assert.equal(it.pending, false);
  assert.equal(it.pendingDep, null);
  assert.equal(it.stage, 'IN STOCK');
});

test('identical devices: older purchase first, flagged ambiguous; two deposits never share a device', () => {
  const newer = item({ name: 'Apple Macbook Air M1', kind: 'PC', buyDate: D(2026, 11, 11), row: 9 });
  const older = item({ name: 'Apple Macbook Air M1', kind: 'PC', buyDate: D(2026, 11, 9), row: 8 });
  let r = linkDepositsToItems([newer, older], [dep({ device: 'Apple Macbook Air M1' })]);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].item, older);
  assert.equal(r.links[0].ambiguous, true);
  const two = [dep({ id: 'A', device: 'Apple Macbook Air M1', dateIn: D(2026, 11, 2) }), dep({ id: 'B', device: 'Apple Macbook Air M1', dateIn: D(2026, 11, 3) })];
  r = linkDepositsToItems([newer, older], two);
  assert.equal(r.links.length, 2);
  assert.notEqual(r.links[0].item, r.links[1].item);
  assert.equal(r.links[1].ambiguous, false);   // only one device was left to choose from
  const three = two.concat(dep({ id: 'C', device: 'Apple Macbook Air M1', dateIn: D(2026, 11, 4) }));
  r = linkDepositsToItems([newer, older], three);
  assert.equal(r.links.length, 2);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].id, 'C');
});

test('device picker list: unsold and not pending, grouped by kind, text matches what the matcher reads', () => {
  const phone = item({ kind: 'Phone', name: 'Pixel 9 Pro', label: 'Pixel 9 Pro - Bought $400' });
  const pc = item({ kind: 'PC', name: 'ASUS TUF F15' });
  const acc = item({ kind: 'Accessory', name: 'Anker Charger', buyPrice: 12 });
  const sold = item({ kind: 'Phone', name: 'Old phone', sold: true });
  const held = item({ kind: 'PC', name: 'Held PC' });
  applyPendingDeposits([phone, pc, acc, sold, held], [dep({ device: 'Held PC' })]);
  const g = plain(stockForDeposit([phone, pc, acc, sold, held]));
  assert.deepEqual(Object.keys(g), ['Phone', 'PC', 'Accessory']);
  assert.deepEqual(g.Phone.map(x => x.name), ['Pixel 9 Pro']);
  assert.deepEqual(g.PC.map(x => x.name), ['ASUS TUF F15']);
  assert.deepEqual(g.Accessory.map(x => x.name), ['Anker Charger']);
  assert.equal(g.Phone[0].text, 'Pixel 9 Pro - Bought $400');
  assert.equal(g.Accessory[0].cost, 12);
  // writing the picker's text into a deposit marks that exact device
  const fresh = item({ kind: 'Phone', name: 'Pixel 9 Pro', label: 'Pixel 9 Pro - Bought $400' });
  applyPendingDeposits([fresh], [dep({ device: g.Phone[0].text })]);
  assert.equal(fresh.pending, true);
  assert.equal(depositDeviceText(null), '');
});

test('bad input never throws and never changes the list', () => {
  for (const bad of [null, undefined, 'x', 5, {}, [null, undefined, 3, 'a']]) {
    assert.doesNotThrow(() => applyPendingDeposits(bad, bad));
    assert.doesNotThrow(() => linkDepositsToItems(bad, bad));
    assert.doesNotThrow(() => stockForDeposit(bad));
  }
  const items = [item({ name: 'A' }), null, item({ name: 'B' })];
  const r = applyPendingDeposits(items, [null, dep({ device: 'B' }), { open: true }]);
  assert.equal(items.length, 3);
  assert.equal(r.linked, 1);
  assert.deepEqual(plain(stockForDeposit(null)), { Phone: [], PC: [], Accessory: [] });
});

test('wiring: normalize() calls it inside a try, and inventoryStats keeps `stock` and adds available / pending', () => {
  assert.match(html, /try\{let ds=\[\];try\{const om=owedModel\(raw\);if\(om&&om\.hasOwed\)ds=om\.deps\}catch\(e\)\{\}deposits=applyPendingDeposits\(items,ds\)\}catch\(e\)\{\}/);
  // the failure path calls nothing, so a page or test sandbox that lacks these helpers still loads exactly as before
  const wire = html.slice(html.indexOf('let deposits={linked:0'), html.indexOf('return {expenses,items,investments,issues,counts,byId,deposits};'));
  assert.ok(!/catch\(e\)\{[^}]*applyPendingDeposits/.test(wire), 'no helper call inside a catch');
  assert.match(html, /return \{expenses,items,investments,issues,counts,byId,deposits\};/);
  assert.match(html, /return\{stock,available:stock\.filter\(i=>!i\.pending\),pending:stock\.filter\(i=>i\.pending\),cost:sum\(stock,i=>i\.buyPrice\),/);
  assert.match(html, /const stock=D\.items\.filter\(i=>!i\.sold\);/);
});

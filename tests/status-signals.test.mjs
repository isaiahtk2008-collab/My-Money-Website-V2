// Run with: node tests/status-signals.test.mjs
// Proves the read-only status engine: overdue timing and the grace setting, issue rules for Loan out, Deposit taken, Bought PC and Sold phone,
// Row ID checks use the Row ID (not the sheet row number), settings are cleaned up, bad data never throws, and nothing in the input is changed.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const a = html.indexOf('/* ===== STATUS SIGNALS ENGINE START ===== */');
const b = html.indexOf('/* ===== STATUS SIGNALS ENGINE END ===== */');
assert.ok(a > 0 && b > a, 'engine markers found');
const block = html.slice(a, b);
assert.ok(!/fetch|sheetCall|XMLHttpRequest|store\.set|sendBeacon/.test(block), 'engine contains no write or network calls');

const store = {};
const ctx = vm.createContext({ LS: { get: k => store[k] ?? '', set: (k, v) => { store[k] = v; } }, Date, Math, JSON, Object, Array, String, parseInt, isNaN });
vm.runInContext(block + '\nthis.api={ssBuild,ssNormPrefs,ssLoadPrefs,ssSavePrefs,ssWorst,SS_DEFAULTS};', ctx);
const { ssBuild, ssNormPrefs, ssLoadPrefs, ssSavePrefs, ssWorst } = ctx.api;

const D = (y, m, d) => new Date(y, m - 1, d);
const today = D(2026, 10, 31);
const fmt = { mny: n => '$' + n, fdy: d => d.toISOString().slice(0, 10) };
const run = o => JSON.parse(JSON.stringify(ssBuild(Object.assign({ items: [], owed: { hasOwed: true, loans: [], deps: [] }, raw: {}, today, prefs: { graceDays: 0 }, fmt }, o))));
const loan = o => Object.assign({ id: 'L1', row: 2, name: 'Sam', item: 'iPhone', loaned: 200, repaid: 50, owed: 150, due: D(2026, 11, 20), open: true }, o);
const dep = o => Object.assign({ id: 'D1', row: 3, name: 'Ali', device: 'PC', total: 500, paid: 100, balance: 400, pickup: D(2026, 11, 20), open: true }, o);

// prefs
assert.deepEqual(JSON.parse(JSON.stringify(ssNormPrefs(null))), { graceDays: 0, openMode: 'direct', hover: true });
assert.equal(ssNormPrefs({ graceDays: '7.9' }).graceDays, 7);
assert.equal(ssNormPrefs({ graceDays: -4 }).graceDays, 0);
assert.equal(ssNormPrefs({ graceDays: 9999 }).graceDays, 365);
assert.equal(ssNormPrefs({ graceDays: 'abc' }).graceDays, 0);
assert.equal(ssNormPrefs({ openMode: 'weird' }).openMode, 'direct');
assert.equal(ssNormPrefs({ openMode: 'filtered' }).openMode, 'filtered');
assert.equal(ssNormPrefs({ hover: false }).hover, false);
assert.equal(ssNormPrefs({ hover: 'false' }).hover, false);
assert.equal(ssNormPrefs({ hover: 'yes' }).hover, true);
assert.equal(ssLoadPrefs().graceDays, 0);
ssSavePrefs({ graceDays: 3, openMode: 'filtered', hover: false });
assert.deepEqual(JSON.parse(JSON.stringify(ssLoadPrefs())), { graceDays: 3, openMode: 'filtered', hover: false });
store['ss.prefs'] = '{not json';
assert.equal(ssLoadPrefs().openMode, 'direct');
assert.equal(ssWorst(['pending', null, 'overdue', 'issue']), 'overdue');
assert.equal(ssWorst([]), null);
assert.equal(ssWorst('x'), null);

// shape: all four keys always there
let r = run({});
for (const k of ['loan', 'dep', 'bpc', 'sphone']) assert.deepEqual(JSON.parse(JSON.stringify(r[k])), { level: null, count: 0, entries: [] });

// loan: pending, due date itself is NOT overdue, day after IS overdue
r = run({ owed: { hasOwed: true, loans: [loan({})], deps: [] }, raw: { Owed: { rows: [{ 'Row ID': 'L1' }] } } });
assert.equal(r.loan.level, 'pending');
assert.match(r.loan.entries[0].reasons[0], /owes \$150/);
r = run({ owed: { hasOwed: true, loans: [loan({ due: D(2026, 10, 31) })], deps: [] }, raw: { Owed: { rows: [{ 'Row ID': 'L1' }] } } });
assert.equal(r.loan.level, 'pending', 'due today is not overdue');
r = run({ owed: { hasOwed: true, loans: [loan({ due: D(2026, 10, 30) })], deps: [] }, raw: { Owed: { rows: [{ 'Row ID': 'L1' }] } } });
assert.equal(r.loan.level, 'overdue', 'one day past is overdue');
assert.match(r.loan.entries[0].reasons[0], /^1 day past return date/);
// grace setting
r = run({ prefs: { graceDays: 3 }, owed: { hasOwed: true, loans: [loan({ due: D(2026, 10, 28) }), loan({ id: 'L2', due: D(2026, 10, 27) })], deps: [] }, raw: { Owed: { rows: [{ 'Row ID': 'L1' }, { 'Row ID': 'L2' }] } } });
assert.equal(r.loan.entries.find(e => e.target.id === 'L1').level, 'pending', '3 days past with 3 days grace is not overdue yet');
assert.equal(r.loan.entries.find(e => e.target.id === 'L2').level, 'overdue');
// closed loans are quiet
r = run({ owed: { hasOwed: true, loans: [loan({ open: false, due: D(2026, 1, 1) })], deps: [] }, raw: { Owed: { rows: [{ 'Row ID': 'L1' }] } } });
assert.equal(r.loan.count, 0);
// loan issues, and overdue outranks issue but keeps the reasons
r = run({ owed: { hasOwed: true, loans: [loan({ loaned: 0, owed: 0, repaid: 0, due: null, id: '' })], deps: [] }, raw: { Owed: { rows: [] } } });
assert.equal(r.loan.level, 'issue');
for (const t of [/No loan amount/, /No return date/, /No Row ID/]) assert.ok(r.loan.entries[0].reasons.some(x => t.test(x)), String(t));
r = run({ owed: { hasOwed: true, loans: [loan({ due: D(2026, 10, 1), id: '' })], deps: [] }, raw: {} });
assert.equal(r.loan.level, 'overdue');
assert.ok(r.loan.entries[0].reasons.some(x => /No Row ID/.test(x)));
r = run({ owed: { hasOwed: true, loans: [loan({ repaid: 300 })], deps: [] }, raw: { Owed: { rows: [{ 'Row ID': 'L1' }] } } });
assert.ok(r.loan.entries[0].reasons.some(x => /more than the amount loaned/.test(x)));
// duplicate Row ID uses the Row ID column, not the sheet row number
r = run({ owed: { hasOwed: true, loans: [loan({ id: 'X', row: 2 }), loan({ id: 'Y', row: 3 })], deps: [] }, raw: { Owed: { rows: [{ 'Row ID': 'X' }, { 'Row ID': ' X ' }, { 'Row ID': 'Y' }] } } });
assert.equal(r.loan.entries.find(e => e.target.id === 'X').level, 'issue');
assert.equal(r.loan.entries.find(e => e.target.id === 'Y').level, 'pending');
r = run({ owed: { hasOwed: true, loans: [loan({ id: 'A1', row: 2 })], deps: [] }, raw: { Owed: { rows: [{ 'Row ID': 'A1' }, { 'Row ID': 'B2' }] } } });
assert.equal(r.loan.level, 'pending', 'a Row ID that is unique is fine even if other numbers look alike');

// deposits
r = run({ owed: { hasOwed: true, loans: [], deps: [dep({}), dep({ id: 'D2', pickup: D(2026, 10, 20) }), dep({ id: 'D3', total: 0, balance: 0 })] }, raw: { Owed: { rows: [{ 'Row ID': 'D1' }, { 'Row ID': 'D2' }, { 'Row ID': 'D3' }] } } });
assert.equal(r.dep.entries.find(e => e.target.id === 'D1').level, 'pending');
assert.match(r.dep.entries.find(e => e.target.id === 'D1').reasons[0], /\$400 still to pay/);
assert.equal(r.dep.entries.find(e => e.target.id === 'D2').level, 'overdue');
assert.match(r.dep.entries.find(e => e.target.id === 'D2').reasons[0], /past pickup date/);
assert.equal(r.dep.entries.find(e => e.target.id === 'D3').level, 'issue');
assert.deepEqual(r.dep.entries.map(e => e.level), ['overdue', 'issue', 'pending'], 'sorted worst first');
assert.equal(r.dep.level, 'overdue');
assert.equal(r.dep.count, 3);

// Owed tab missing
r = run({ owed: { hasOwed: false, loans: [loan({})], deps: [] } });
assert.equal(r.loan.count, 0);

// devices
const items = [
  { id: 'i0', kind: 'PC', name: 'Dell', buyPrice: null, buyDate: D(2026, 9, 1), sold: false, row: 5 },
  { id: 'i1', kind: 'PC', name: 'HP', buyPrice: 100, buyDate: D(2026, 9, 1), sold: false, row: 6 },
  { id: 'i2', kind: 'Phone', name: 'iPhone 12', buyPrice: 300, buyDate: D(2026, 9, 5), sold: true, sellPrice: null, sellDate: null, row: 7 },
  { id: 'i3', kind: 'Phone', name: 'Pixel', buyPrice: 100, buyDate: D(2026, 9, 5), sold: false, sellPrice: null, row: 8 },
  { id: 'i4', kind: 'Phone', name: 'S21', buyPrice: 100, buyDate: D(2026, 9, 5), sold: true, sellPrice: 200, sellDate: D(2026, 9, 1), row: 9 },
  { id: 'i5', kind: 'Phone', name: 'Fine', buyPrice: 100, buyDate: D(2026, 9, 5), sold: true, sellPrice: 200, sellDate: D(2026, 9, 9), row: 10 },
  { id: 'i6', kind: 'PC', name: 'Unnamed', buyPrice: 50, buyDate: null, sold: false, row: 11 }
];
r = run({ items, raw: { BoughtPCs: { rows: [{ 'Row ID': 'Q' }, { 'Row ID': 'Q' }, { 'Row ID': 'R' }] }, SoldPhones: { rows: [{ 'Row ID': 'S' }, { 'Row ID': 'S' }, { 'Row ID': 'S' }] } } });
assert.deepEqual(r.bpc.entries.map(e => e.key).sort(), ['bpc_dup_Q', 'bpc_i0', 'bpc_i6']);
assert.ok(r.bpc.entries.find(e => e.key === 'bpc_i0').reasons[0].includes('No purchase price'));
assert.deepEqual(r.bpc.entries.find(e => e.key === 'bpc_dup_Q').target, { type: 'view', view: 'data' });
assert.deepEqual(r.bpc.entries.find(e => e.key === 'bpc_i0').target, { type: 'item', id: 'i0' });
assert.ok(r.bpc.entries.every(e => e.level === 'issue'));
assert.deepEqual(r.sphone.entries.map(e => e.key).sort(), ['sphone_dup_S', 'sphone_i2', 'sphone_i4']);
assert.match(r.sphone.entries.find(e => e.key === 'sphone_dup_S').reasons[0], /Used by 3 rows in the Sold phone tab/);
assert.equal(r.sphone.entries.find(e => e.key === 'sphone_i2').reasons.length, 2, 'no sale price and no sale date');
assert.ok(r.sphone.entries.find(e => e.key === 'sphone_i4').reasons[0].includes('before the purchase date'));
assert.ok(!r.sphone.entries.some(e => e.key === 'sphone_i3'), 'unsold phones are not flagged');

// never throws on garbage, never changes its input
for (const bad of [undefined, null, 5, 'x', {}, { items: 5, owed: 7, raw: 'x', today: 'now', fmt: 3 }, { items: [null, 1, {}], owed: { hasOwed: true, loans: [null, {}], deps: [null, 3] }, raw: { Owed: { rows: [null, 1] } } }]) {
  const out = ssBuild(bad);
  for (const k of ['loan', 'dep', 'bpc', 'sphone']) assert.ok(out[k] && Array.isArray(out[k].entries), 'shape kept for ' + JSON.stringify(bad));
}
const input = { items, owed: { hasOwed: true, loans: [loan({})], deps: [dep({})] }, raw: { Owed: { rows: [{ 'Row ID': 'L1' }] } }, today, prefs: { graceDays: 0 }, fmt };
const before = JSON.stringify(input);
ssBuild(input);
assert.equal(JSON.stringify(input), before, 'input untouched');

console.log('status-signals: all checks passed');

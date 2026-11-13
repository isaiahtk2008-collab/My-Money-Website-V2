// Run with: node --test tests/expiry-banner.test.mjs
// Loads the REAL "EXPIRY BANNER CORE" block out of index.html (no copies) and proves:
//  - settings are cleaned up (on by default, bad values fall back, numbers are clamped)
//  - which deposits and loans show: open, with a date, within the days threshold or already overdue; closed / undated / far-off ones never show
//  - day counting is by calendar day in America/Toronto, including the daylight-saving change days and month/year ends
//  - severity: due soon = pending (yellow), past due = overdue (blinking red); order is overdue first, then soonest
//  - snooze hides an item until the chosen day, old snoozes are pruned, and the input is never changed
//  - rotation wraps and survives bad numbers; bad input never throws
//  - the block touches no storage, network or page, and the UI code that uses it never writes to the sheet
process.env.TZ = 'America/Toronto';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('/* ===== EXPIRY BANNER CORE START ===== */');
const b = html.indexOf('/* ===== EXPIRY BANNER CORE END ===== */');
assert.ok(a > 0 && b > a, 'expiry banner markers found');
const block = html.slice(a, b);
assert.ok(!/fetch|sheetCall|XMLHttpRequest|localStorage|sessionStorage|sendBeacon|document\.|window\.|LS\./.test(block), 'core has no network, storage or page access');

const ctx = vm.createContext({ Date, Math, JSON, Object, Array, String, Number, parseInt, isNaN });
vm.runInContext(block + '\nthis.api={EB_DEFAULTS,ebNormalize,ebItems,ebNext,ebPrune,ebSnooze,ebDaysBetween,ebDayKey,ebWhen,ebKey};', ctx);
const { ebNormalize, ebItems: rawItems, ebNext, ebPrune, ebSnooze, ebDaysBetween, ebDayKey, ebWhen, ebKey } = ctx.api;

const plain = x => JSON.parse(JSON.stringify(x));
const ebItems = (...args) => plain(rawItems(...args));   // plain copies, so deepEqual is not confused by objects made in the vm context
const D = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);
const cfg = o => Object.assign({ enabled: true, depDays: 3, loanDays: 3 }, o);
const dep = o => Object.assign({ id: 'D1', row: 3, name: 'Ali', device: 'Pixel 9', total: 500, paid: 100, balance: 400, pickup: D(2026, 11, 14), open: true }, o);
const loan = o => Object.assign({ id: 'L1', row: 2, name: 'Sam', item: 'iPhone', loaned: 200, repaid: 50, owed: 150, due: D(2026, 11, 14), open: true }, o);
const owed = (deps, loans) => ({ hasOwed: true, deps: deps || [], loans: loans || [] });
const today = D(2026, 11, 13, 0, 18);

test('the test runs in America/Toronto', () => {
  assert.equal(new Date(2026, 6, 1).getTimezoneOffset(), 240, 'EDT in July');
  assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), 300, 'EST in January');
});

test('settings: on by default, bad values fall back, numbers are clamped', () => {
  assert.deepEqual(plain(ebNormalize(null)), { enabled: true, position: 'bottom', size: 'medium', depDays: 3, loanDays: 3, speed: 6, pause: true });
  assert.deepEqual(plain(ebNormalize('junk')), plain(ebNormalize(undefined)));
  assert.deepEqual(plain(ebNormalize([])), plain(ebNormalize(null)));
  assert.equal(ebNormalize({ enabled: false }).enabled, false);
  assert.equal(ebNormalize({ enabled: 'false' }).enabled, false);
  assert.equal(ebNormalize({ enabled: 'yes' }).enabled, true);
  assert.equal(ebNormalize({ size: 'huge' }).size, 'medium');
  assert.equal(ebNormalize({ size: 'large' }).size, 'large');
  assert.equal(ebNormalize({ position: 'left' }).position, 'bottom', 'only bottom exists in this PR');
  assert.equal(ebNormalize({ depDays: -5 }).depDays, 0);
  assert.equal(ebNormalize({ depDays: 9999 }).depDays, 60);
  assert.equal(ebNormalize({ loanDays: '7.9' }).loanDays, 7);
  assert.equal(ebNormalize({ loanDays: 'abc' }).loanDays, 3);
  assert.equal(ebNormalize({ speed: 1 }).speed, 3);
  assert.equal(ebNormalize({ speed: 500 }).speed, 30);
  assert.equal(ebNormalize({ pause: false }).pause, false);
});

test('calendar-day counting is right across DST changes, month ends and year ends (America/Toronto)', () => {
  assert.equal(ebDaysBetween(D(2026, 11, 13), D(2026, 11, 13)), 0);
  assert.equal(ebDaysBetween(D(2026, 11, 13, 23, 59), D(2026, 11, 14, 0, 1)), 1, 'minutes apart, different days');
  assert.equal(ebDaysBetween(D(2026, 11, 14, 0, 1), D(2026, 11, 13, 23, 59)), -1);
  // clocks go back Sunday 2026-11-01 (25 hour day) and forward Sunday 2026-03-08 (23 hour day)
  assert.equal(ebDaysBetween(D(2026, 10, 31), D(2026, 11, 2)), 2);
  assert.equal(ebDaysBetween(D(2026, 11, 1), D(2026, 11, 2)), 1);
  assert.equal(ebDaysBetween(D(2026, 3, 7), D(2026, 3, 9)), 2);
  assert.equal(ebDaysBetween(D(2026, 3, 8), D(2026, 3, 9)), 1);
  assert.equal(ebDaysBetween(D(2026, 12, 30), D(2027, 1, 2)), 3);
  assert.equal(ebDaysBetween(D(2028, 2, 28), D(2028, 3, 1)), 2, 'leap year');
  assert.equal(ebDayKey(D(2026, 1, 5)), '2026-01-05');
});

test('shows open items inside the threshold; hides far-off, closed and undated ones', () => {
  const r = ebItems(owed(
    [dep({ id: 'near', pickup: D(2026, 11, 16) }), dep({ id: 'far', pickup: D(2026, 11, 17) }), dep({ id: 'closed', open: false, pickup: D(2026, 11, 14) }), dep({ id: 'nodate', pickup: null })],
    [loan({ id: 'lnear', due: D(2026, 11, 13) }), loan({ id: 'lfar', due: D(2026, 12, 1) })]), cfg(), today, {});
  assert.deepEqual(r.map(x => x.key).sort(), ['dep:near', 'loan:lnear']);
});

test('separate thresholds for deposits and loans; 0 means only today and overdue', () => {
  const o = owed([dep({ id: 'd', pickup: D(2026, 11, 20) })], [loan({ id: 'l', due: D(2026, 11, 20) })]);
  assert.deepEqual(ebItems(o, cfg({ depDays: 7, loanDays: 3 }), today, {}).map(x => x.key), ['dep:d']);
  assert.deepEqual(ebItems(o, cfg({ depDays: 3, loanDays: 7 }), today, {}).map(x => x.key), ['loan:l']);
  const z = owed([dep({ id: 't', pickup: D(2026, 11, 13) }), dep({ id: 'm', pickup: D(2026, 11, 14) }), dep({ id: 'o', pickup: D(2026, 11, 12) })]);
  assert.deepEqual(ebItems(z, cfg({ depDays: 0 }), today, {}).map(x => x.key), ['dep:o', 'dep:t']);
});

test('severity and order: overdue (blinking red) first, then soonest; wording matches', () => {
  const r = ebItems(owed(
    [dep({ id: 'a', pickup: D(2026, 11, 15) }), dep({ id: 'b', pickup: D(2026, 11, 12) })],
    [loan({ id: 'c', due: D(2026, 11, 13) }), loan({ id: 'd', due: D(2026, 11, 1) })]), cfg(), today, {});
  assert.deepEqual(r.map(x => x.key), ['loan:d', 'dep:b', 'loan:c', 'dep:a']);
  assert.deepEqual(r.map(x => x.level), ['overdue', 'overdue', 'pending', 'pending']);
  assert.equal(r[0].when, '12 days overdue');
  assert.equal(r[1].when, '1 day overdue');
  assert.equal(r[2].when, 'due today');
  assert.equal(ebWhen(1), 'due tomorrow');
  assert.equal(ebWhen(2), 'due in 2 days');
});

test('due at 11:59 pm and 12:01 am on the same day count as the same day', () => {
  const late = D(2026, 11, 13, 23, 59);
  const r = ebItems(owed([dep({ pickup: D(2026, 11, 13) })]), cfg(), late, {});
  assert.equal(r[0].daysLeft, 0);
  assert.equal(r[0].level, 'pending');
  const next = D(2026, 11, 14, 0, 1);
  assert.equal(ebItems(owed([dep({ pickup: D(2026, 11, 13) })]), cfg(), next, {})[0].level, 'overdue');
});

test('disabled setting shows nothing', () => {
  assert.deepEqual(ebItems(owed([dep({})]), cfg({ enabled: false }), today, {}), []);
});

test('snooze hides an item until the chosen day arrives, then it returns', () => {
  const o = owed([dep({ id: 'x', pickup: D(2026, 11, 14) })]);
  const sn = ebSnooze({}, 'dep:x', today, 1);
  assert.deepEqual(plain(sn), { 'dep:x': '2026-11-14' });
  assert.equal(ebItems(o, cfg(), today, sn).length, 0, 'hidden today');
  assert.equal(ebItems(o, cfg(), D(2026, 11, 13, 23, 59), sn).length, 0, 'hidden all day');
  assert.equal(ebItems(o, cfg(), D(2026, 11, 14, 0, 1), sn).length, 1, 'back tomorrow');
  assert.equal(ebSnooze({}, 'dep:x', today, 3)['dep:x'], '2026-11-16');
  assert.equal(ebSnooze({}, 'dep:x', D(2026, 12, 31), 1)['dep:x'], '2027-01-01', 'year end');
  assert.equal(ebItems(owed([dep({ id: 'x' }), dep({ id: 'y' })]), cfg(), today, sn).length, 1, 'only the snoozed item is hidden');
});

test('pruning drops old, malformed and excess snoozes', () => {
  const m = { a: '2026-11-12', b: '2026-11-13', c: '2026-11-14', d: 'tomorrow', e: 5, f: null };
  assert.deepEqual(plain(ebPrune(m, '2026-11-13')), { c: '2026-11-14' });
  assert.deepEqual(plain(ebPrune(null, '2026-11-13')), {});
  assert.deepEqual(plain(ebPrune([1, 2], '2026-11-13')), {});
  assert.deepEqual(plain(ebPrune('x', '2026-11-13')), {});
  const big = {}; for (let i = 0; i < 500; i++) big['k' + i] = '2027-01-01';
  assert.equal(Object.keys(ebPrune(big, '2026-11-13')).length, 200);
});

test('items without a Row ID still get a stable key; keys differ between a loan and a deposit', () => {
  assert.equal(ebKey('dep', { id: '', row: 7, name: ' Ali ' }), 'dep:row7-ali');
  assert.equal(ebKey('dep', { id: 'X' }), 'dep:X');
  assert.notEqual(ebKey('dep', { id: 'X' }), ebKey('loan', { id: 'X' }));
  const r = ebItems(owed([dep({ id: '', row: 9, name: 'Bo' })]), cfg(), today, {});
  assert.equal(r[0].key, 'dep:row9-bo');
});

test('rotation wraps and survives bad numbers', () => {
  assert.equal(ebNext(0, 3), 1);
  assert.equal(ebNext(2, 3), 0);
  assert.equal(ebNext(0, 1), 0);
  assert.equal(ebNext(0, 0), 0);
  assert.equal(ebNext(-4, 3), 0);
  assert.equal(ebNext('x', 3), 0);
  assert.equal(ebNext(1, 'abc'), 0);
  assert.equal(ebNext(7, 3), 2, 'an index past the end still wraps');
  let i = 0; const seen = []; for (let n = 0; n < 7; n++) { seen.push(i); i = ebNext(i, 3); }
  assert.deepEqual(seen, [0, 1, 2, 0, 1, 2, 0]);
});

test('bad input never throws and never changes the input', () => {
  for (const bad of [null, undefined, 5, 'x', {}, { deps: 'no', loans: 7 }, { deps: [null, 1, 'a', {}], loans: [undefined] }]) {
    assert.deepEqual(ebItems(bad, cfg(), today, {}), []);
  }
  assert.deepEqual(ebItems(owed([dep({})]), cfg(), null, {}), []);
  assert.deepEqual(ebItems(owed([dep({})]), cfg(), new Date('nope'), {}), []);
  assert.deepEqual(ebItems(owed([dep({ pickup: new Date('nope') })]), cfg(), today, {}), []);
  assert.equal(ebItems(owed([dep({})]), null, today, {}).length, 0);
  assert.equal(ebItems(owed([dep({})]), cfg(), today, 'junk').length, 1, 'a bad snooze map is ignored');
  const input = owed([dep({ id: 'p', pickup: D(2026, 11, 14) })], [loan({})]);
  const before = JSON.stringify(input);
  ebItems(input, cfg(), today, { 'dep:p': '2026-11-14' });
  assert.equal(JSON.stringify(input), before);
});

test('amounts and text come through for display; the UI is read-only and escapes sheet text', () => {
  const r = ebItems(owed([dep({ balance: 400, device: 'Pixel 9', name: 'Ali' })], [loan({ owed: 150, item: 'iPhone' })]), cfg(), today, {});
  const d = r.find(x => x.kind === 'dep'), l = r.find(x => x.kind === 'loan');
  assert.equal(d.amount, 400); assert.equal(d.what, 'Pixel 9'); assert.equal(d.name, 'Ali');
  assert.equal(l.amount, 150); assert.equal(l.what, 'iPhone');
  const ui = html.slice(b, html.indexOf("setTimeout(()=>flush(true),2500);"));
  assert.ok(!/fetch\(|sheetCall|XMLHttpRequest|sendBeacon|store\.set|LS\.set|apps-script/.test(ui), 'UI has no sheet or network writes');
  assert.ok(/esc2\(it\.name\)|esc2\(head\)/.test(ui) && /esc2\(bits\.join/.test(ui), 'sheet text is escaped before it goes into the page');
  assert.ok(/prefers-reduced-motion|transitionDuration/.test(ui), 'reduced motion / animation speed are respected');
});

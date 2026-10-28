// Run with: node --test tests/trade-total.test.mjs
// Loads the REAL checkTradeTotals out of index.html (no copy) and proves the Sold forms' Payment Type rule:
//  - Trade/Mixed: Cash Received + Trade-In Value must equal Sale Price (tolerance 0.005)
//  - Cash (or anything else) ignores the trade fields completely
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
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
vm.runInContext(fnBlock('checkTradeTotals') + '\nglobalThis.__t={checkTradeTotals};', ctx);
// Objects made inside the vm sandbox have a different Object prototype, which strict deepEqual rejects,
// so copy each result into a plain object of this realm (numbers and strings are kept exactly, including -0).
const raw = ctx.__t.checkTradeTotals;
const checkTradeTotals = (...a) => { const r = raw(...a); return { ok: r.ok, diff: r.diff, msg: r.msg }; };

test('exact: cash + trade equals sale price', () => {
  assert.deepEqual(checkTradeTotals('Mixed', 500, 350, 150), { ok: true, diff: 0, msg: '' });
});

test('off by a cent (short and over) is blocked with a clear message', () => {
  assert.deepEqual(checkTradeTotals('Mixed', 500, 350, 149.99), {
    ok: false,
    diff: -0.01,
    msg: 'Cash + Trade-In = $499.99, but Sale Price is $500.00 (short by $0.01)'
  });
  assert.deepEqual(checkTradeTotals('Mixed', 500, 350, 150.01), {
    ok: false,
    diff: 0.01,
    msg: 'Cash + Trade-In = $500.01, but Sale Price is $500.00 (over by $0.01)'
  });
});

test('Trade with zero cash is fine when the trade-in covers the sale price', () => {
  assert.equal(checkTradeTotals('Trade', 500, 0, 500).ok, true);
  assert.equal(checkTradeTotals('Trade', 500, 0, 450).ok, false);
});

test('Cash type ignores the trade fields (and so does a blank or unknown type)', () => {
  assert.deepEqual(checkTradeTotals('Cash', 500, 999, 999), { ok: true, diff: 0, msg: '' });
  assert.deepEqual(checkTradeTotals('Cash', null, null, null), { ok: true, diff: 0, msg: '' });
  assert.deepEqual(checkTradeTotals('', 500, 999, 999), { ok: true, diff: 0, msg: '' });
  assert.deepEqual(checkTradeTotals(undefined, 500, 999, 999), { ok: true, diff: 0, msg: '' });
});

test('tolerance is 0.005 on the raw difference', () => {
  assert.equal(checkTradeTotals('Mixed', 100, 60, 40.004).ok, true);
  assert.equal(checkTradeTotals('Mixed', 100, 60, 40.006).ok, false);
});

test('blank or invalid numbers block saving without a message (the form shows Required)', () => {
  assert.deepEqual(checkTradeTotals('Trade', 500, null, 500), { ok: false, diff: null, msg: '' });
  assert.deepEqual(checkTradeTotals('Trade', 500, 500, null), { ok: false, diff: null, msg: '' });
  assert.deepEqual(checkTradeTotals('Trade', null, 500, 500), { ok: false, diff: null, msg: '' });
});

test('floating point noise does not block a matching total, and never returns -0', () => {
  const r = checkTradeTotals('Mixed', 0.3, 0.1, 0.2);
  assert.equal(r.ok, true);
  assert.ok(Object.is(r.diff, 0));
});

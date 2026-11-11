// Run with: node --test tests/trading-edits.test.mjs
// The two PURE change builders behind the "Close / edit trade" and "Update IPO bid" pop-ups (index.html). They decide exactly what is written to the sheet,
// so this proves: bad input is refused with a plain message, nothing is sent when nothing changed, only the columns that really changed are included,
// dates / numbers / clears have the right shape, reopening clears the close date, an unusual existing status can stay as it is,
// and every request carries a lock (Row ID + at least one more column) so the script can refuse if the row moved.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
function constLine(n) { const m = html.match(new RegExp('^const ' + n + ' ?=', 'm')); if (!m) throw new Error('const ' + n + ' missing'); const lines = html.slice(m.index).split('\n'); let code = ''; for (const l of lines) { code += (code ? '\n' : '') + l; try { new Function(code); return code; } catch (e) {} } throw new Error('const ' + n + ' unparsable'); }
function fnBlock(name) { const s = html.indexOf('function ' + name + '('); if (s < 0) throw new Error('fn ' + name + ' missing'); let i = html.indexOf('{', html.indexOf(')', s)), d = 0; for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (!d) return html.slice(s, i + 1); } } throw new Error('unbalanced ' + name); }

const consts = ['sod', 'DAY', 'TODAY', 'diffD', 'pd', 'num', 'sum', 'owedStr', 'isoDay', 'IPO_STATUSES'].map(constLine);
const funcs = ['trStr', 'trBlankRow', 'trAsset', 'trDir', 'trStatus', 'tradingModel', 'ipoStage', 'ipoNext', 'preIpoModel', 'trNumDiff', 'tradeChanges', 'ipoChanges'].map(fnBlock);
const ctx = vm.createContext({ Intl, Math, Date, Set, Map, Array, Object, JSON, Number, String, RegExp, console });
vm.runInContext([...consts, ...funcs, 'globalThis.__t={tradingModel,preIpoModel,tradeChanges,ipoChanges};'].join('\n'), ctx);
const { tradingModel, preIpoModel, tradeChanges, ipoChanges } = ctx.__t;

const NOW = new Date(2026, 10, 11);
const plain = x => JSON.parse(JSON.stringify(x));
const trade = (row, input) => {
  const m = tradingModel({ Trades: { rows: [Object.assign({ _row: 2 }, row)] } }, NOW);
  return plain(tradeChanges(m.trades[0], input, NOW));
};
const OPEN = { 'Row ID': 'T1', Symbol: 'aapl', Status: 'Open', Quantity: 10, 'Entry Price': 180, Currency: 'USD', 'Date Opened': '2026-11-01' };
const CLOSED = { 'Row ID': 'T2', Symbol: 'ETH', Status: 'Closed', Quantity: 2, 'Entry Price': 3000, 'Exit Price': 3300, Fees: 4, Currency: 'USD', 'Date Opened': '2026-10-01', 'Date Closed': '2026-10-05', Notes: 'dip buy' };
const same = c => ({ status: c.Status, exit: c['Exit Price'] == null ? '' : String(c['Exit Price']), fees: c.Fees == null ? '' : String(c.Fees), closedOn: c['Date Closed'] || '', notes: c.Notes || '' });

test('close an open trade: Status, Exit Price and Date Closed (defaults to today) are written; the lock has Row ID, Symbol, Quantity, Entry Price', () => {
  const r = trade(OPEN, { status: 'Closed', exit: '$190.50', fees: '2', closedOn: '', notes: '' });
  assert.deepEqual(r.changes, { Status: 'Closed', 'Exit Price': 190.5, Fees: 2, 'Date Closed': { $date: '2026-11-11' } });
  assert.deepEqual(r.patch, { Status: 'Closed', 'Exit Price': 190.5, Fees: 2, 'Date Closed': '2026-11-11' });
  assert.deepEqual(r.expect, { 'Row ID': 'T1', Symbol: 'AAPL', Quantity: 10, 'Entry Price': 180 });
});

test('a chosen close date is used as typed', () => {
  const r = trade(OPEN, { status: 'Closed', exit: '185', closedOn: '2026-11-05' });
  assert.deepEqual(r.changes['Date Closed'], { $date: '2026-11-05' });
});

test('refusals: closing without an exit, bad or negative numbers, bad dates, a close date before the open date, a bad status', () => {
  assert.equal(trade(OPEN, { status: 'Closed', exit: '' }).error, 'Enter the exit price to close this trade');
  assert.equal(trade(OPEN, { status: 'Closed', exit: 'abc' }).error, 'Enter an exit price of 0 or more');
  assert.equal(trade(OPEN, { status: 'Closed', exit: '-5' }).error, 'Enter an exit price of 0 or more');
  assert.equal(trade(OPEN, { status: 'Open', exit: '', fees: 'x' }).error, 'Enter fees of 0 or more');
  assert.equal(trade(OPEN, { status: 'Open', exit: '', fees: '-1' }).error, 'Enter fees of 0 or more');
  assert.equal(trade(OPEN, { status: 'Closed', exit: '190', closedOn: '11/05/2026' }).error, 'Enter a valid close date');
  assert.equal(trade(OPEN, { status: 'Closed', exit: '190', closedOn: '2026-02-31x' }).error, 'Enter a valid close date');
  assert.equal(trade(OPEN, { status: 'Closed', exit: '190', closedOn: '2026-10-15' }).error, 'The close date is before the trade was opened');
  assert.equal(trade(OPEN, { status: 'Maybe', exit: '' }).error, 'Choose Open or Closed');
  assert.equal(trade(OPEN, null).error, 'Choose Open or Closed');
});

test('nothing changed means nothing is sent', () => {
  assert.equal(trade(CLOSED, same(CLOSED)).error, 'No changes to save');
  assert.equal(trade(OPEN, { status: 'open', exit: '', fees: '', closedOn: '', notes: '' }).error, 'No changes to save');
});

test('only the columns that really changed are included', () => {
  assert.deepEqual(Object.keys(trade(CLOSED, Object.assign(same(CLOSED), { exit: '3350' })).changes), ['Exit Price']);
  assert.deepEqual(Object.keys(trade(CLOSED, Object.assign(same(CLOSED), { fees: '6' })).changes), ['Fees']);
  assert.deepEqual(Object.keys(trade(CLOSED, Object.assign(same(CLOSED), { notes: 'sold the pop' })).changes), ['Notes']);
  assert.deepEqual(Object.keys(trade(CLOSED, Object.assign(same(CLOSED), { closedOn: '2026-10-06' })).changes), ['Date Closed']);
});

test('clearing: blank fees means 0, a cleared note is written as empty (null)', () => {
  const r = trade(CLOSED, Object.assign(same(CLOSED), { fees: '', notes: '' }));
  assert.deepEqual(r.changes, { Fees: 0, Notes: null });
  assert.deepEqual(r.patch, { Fees: 0, Notes: null });
});

test('reopening a closed trade clears its close date, and a typed close date is ignored while it is Open', () => {
  const r = trade(CLOSED, Object.assign(same(CLOSED), { status: 'Open' }));
  assert.deepEqual(r.changes, { Status: 'Open', 'Date Closed': null });
  assert.deepEqual(r.patch, { Status: 'Open', 'Date Closed': null });
  const r2 = trade(OPEN, { status: 'Open', exit: '', fees: '', closedOn: '2026-11-05', notes: 'typed a date by mistake' });
  assert.deepEqual(Object.keys(r2.changes), ['Notes']);   // no Date Closed written to an open trade
});

test('a row with no quantity or entry still has a 2-column lock (Row ID + Symbol)', () => {
  const r = trade({ 'Row ID': 'T9', Symbol: 'MSFT', Status: 'Open' }, { status: 'Closed', exit: '10' });
  assert.deepEqual(r.expect, { 'Row ID': 'T9', Symbol: 'MSFT' });
});

const ipo = (row, input, rawRow) => {
  const r = Object.assign({ _row: 2 }, row);
  const m = preIpoModel({ PreIPO: { rows: [r] } }, NOW);
  return plain(ipoChanges(m.items[0], input, rawRow === undefined ? r : rawRow, NOW));
};
const BID = { 'Row ID': 'P1', Company: 'Anthropic', Ticker: 'ANT', Account: 'TFSA', Status: 'Bid placed', 'Date Submitted': '2026-11-10', 'Bid Closes': '2026-11-18', 'Shares Requested': 2, 'Price Low': 70, 'Price High': 78, Currency: 'USD' };
const sameBid = { status: 'Bid placed', allocated: '', final: '', current: '', cost: '', lockup: '', notes: '' };

test('record an allocation: Status, Shares Allocated, Final Price (and a lockup date) are written; the lock has Row ID, Company, Shares Requested', () => {
  const r = ipo(BID, Object.assign({}, sameBid, { status: 'allocated', allocated: '1', final: '74', lockup: '2027-05-30' }));
  assert.deepEqual(r.changes, { Status: 'Allocated', 'Shares Allocated': 1, 'Final Price': 74, 'Lockup Expiry': { $date: '2027-05-30' } });
  assert.deepEqual(r.patch, { Status: 'Allocated', 'Shares Allocated': 1, 'Final Price': 74, 'Lockup Expiry': '2027-05-30' });
  assert.deepEqual(r.expect, { 'Row ID': 'P1', Company: 'Anthropic', 'Shares Requested': 2 });
});

test('refusals: Allocated or Listed without shares, bad numbers, a bad lockup date, an unknown status', () => {
  assert.equal(ipo(BID, Object.assign({}, sameBid, { status: 'Allocated' })).error, 'Enter how many shares you were allocated');
  assert.equal(ipo(BID, Object.assign({}, sameBid, { status: 'Listed', allocated: '0' })).error, 'Enter how many shares you were allocated');
  assert.equal(ipo(BID, Object.assign({}, sameBid, { allocated: 'x' })).error, 'Enter shares allocated of 0 or more');
  assert.equal(ipo(BID, Object.assign({}, sameBid, { final: '-1' })).error, 'Enter a final price of 0 or more');
  assert.equal(ipo(BID, Object.assign({}, sameBid, { current: 'abc' })).error, 'Enter a current price of 0 or more');
  assert.equal(ipo(BID, Object.assign({}, sameBid, { cost: '-5' })).error, 'Enter a cost basis of 0 or more');
  assert.equal(ipo(BID, Object.assign({}, sameBid, { lockup: 'soon' })).error, 'Enter a valid lockup date');
  assert.equal(ipo(BID, Object.assign({}, sameBid, { status: 'Whatever' })).error, 'Choose a status');
});

test('nothing changed means nothing is sent; Not allocated and Cancelled need no shares', () => {
  assert.equal(ipo(BID, sameBid).error, 'No changes to save');
  assert.deepEqual(ipo(BID, Object.assign({}, sameBid, { status: 'Not allocated' })).changes, { Status: 'Not allocated' });
  assert.deepEqual(ipo(BID, Object.assign({}, sameBid, { status: 'Cancelled' })).changes, { Status: 'Cancelled' });
});

test('an unusual existing status ("Submitted") can stay as it is while another field changes; it is never silently rewritten', () => {
  const row = Object.assign({}, BID, { Status: 'Submitted' });
  const r = ipo(row, Object.assign({}, sameBid, { status: 'Submitted', current: '80' }));
  assert.deepEqual(r.changes, { 'Current Price': 80 });
  assert.equal(ipo(row, Object.assign({}, sameBid, { status: 'Submitted' })).error, 'No changes to save');
});

test('current price and cost basis compare against the raw cells; notes are read from the raw row; clearing writes null', () => {
  const row = Object.assign({}, BID, { Status: 'Allocated', 'Shares Allocated': 1, 'Final Price': 74, 'Current Price': 100, 'Cost Basis': 74, Notes: 'hold', 'Lockup Expiry': '2027-05-30' });
  const base = { status: 'Allocated', allocated: '1', final: '74', current: '100', cost: '74', lockup: '2027-05-30', notes: 'hold' };
  assert.equal(ipo(row, base).error, 'No changes to save');
  assert.deepEqual(ipo(row, Object.assign({}, base, { current: '120.5' })).changes, { 'Current Price': 120.5 });
  assert.deepEqual(ipo(row, Object.assign({}, base, { cost: '' })).changes, { 'Cost Basis': null });
  assert.deepEqual(ipo(row, Object.assign({}, base, { lockup: '', notes: '' })).changes, { 'Lockup Expiry': null, Notes: null });
  assert.deepEqual(ipo(row, Object.assign({}, base, { notes: 'sell at lockup' })).patch, { Notes: 'sell at lockup' });
});

test('a row with no Shares Requested still has a 2-column lock (Row ID + Company)', () => {
  const r = ipo({ 'Row ID': 'P5', Company: 'Zed', Status: 'Bid placed' }, Object.assign({}, sameBid, { status: 'Cancelled' }));
  assert.deepEqual(r.expect, { 'Row ID': 'P5', Company: 'Zed' });
});

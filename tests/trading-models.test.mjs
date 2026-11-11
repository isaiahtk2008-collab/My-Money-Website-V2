// Run with: node --test tests/trading-models.test.mjs
// Trading and Pre-IPO models (index.html). Loads the REAL functions out of index.html (no copies) and proves how the "Trades" and "Pre-IPO" sheet tabs are read:
//  - a missing tab, spare empty rows, and rows with no Symbol / Company are handled; Timestamp or Row ID alone never makes a row "real data"
//  - P&L maths for stocks, crypto, options (default multiplier 100), futures, shorts, fees; open and incomplete trades are kept out of the stats
//  - different currencies are never added together
//  - Pre-IPO stages, dates, cost fallback, gain and totals
// Drafted by Gemini 3.5 flash, then reviewed and corrected (every expected number was re-computed by hand).
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
function constLine(n) { const m = html.match(new RegExp('^const ' + n + '=', 'm')); if (!m) throw new Error('const ' + n + ' missing'); const lines = html.slice(m.index).split('\n'); let code = ''; for (const l of lines) { code += (code ? '\n' : '') + l; try { new Function(code); return code; } catch (e) {} } throw new Error('const ' + n + ' unparsable'); }
function fnBlock(name) { const s = html.indexOf('function ' + name + '('); if (s < 0) throw new Error('fn ' + name + ' missing'); let i = html.indexOf('{', html.indexOf(')', s)), d = 0; for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (!d) return html.slice(s, i + 1); } } throw new Error('unbalanced ' + name); }

const consts = ['sod', 'DAY', 'TODAY', 'diffD', 'pd', 'num', 'sum'].map(constLine);
const funcs = ['trStr', 'trBlankRow', 'trAsset', 'trDir', 'trStatus', 'tradingModel', 'ipoStage', 'ipoNext', 'preIpoModel'].map(fnBlock);
const ctx = vm.createContext({ Intl, Math, Date, Set, Map, Array, Object, JSON, Number, String, RegExp, console });
vm.runInContext([...consts, ...funcs, 'globalThis.__t={tradingModel,preIpoModel};'].join('\n'), ctx);
const { tradingModel, preIpoModel } = ctx.__t;

const plain = x => JSON.parse(JSON.stringify(x));
const NOW = new Date(2026, 10, 11);   // fixed "today": 11 Nov 2026
const freeze = o => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(freeze); } return o; };
const T = rows => freeze({ Trades: { rows: rows.map((r, i) => Object.assign({ _row: i + 2 }, r)) } });
const P = rows => freeze({ PreIPO: { rows: rows.map((r, i) => Object.assign({ _row: i + 2 }, r)) } });
const model = raw => plain(tradingModel(raw, NOW));
const ipo = raw => plain(preIpoModel(raw, NOW));

test('tradingModel: a missing or malformed Trades tab gives an empty model and never throws', () => {
  for (const raw of [null, undefined, {}, { Trades: {} }, { Trades: { rows: 'nope' } }]) {
    const m = model(raw);
    assert.equal(m.hasTrades, false);
    assert.deepEqual([m.trades, m.open, m.closed, m.currencies], [[], [], [], []]);
    assert.deepEqual(m.byCurrency, {});
    assert.equal(m.skipped, 0);
  }
  assert.equal(model({ Trades: { rows: [] } }).hasTrades, true);
});

test('tradingModel: spare rows are ignored, a row with data but no Symbol is counted in skipped, and Timestamp / Row ID alone never count', () => {
  const m = model(T([
    { Symbol: null, 'Asset Type': null },
    { Timestamp: '2026-11-01', 'Row ID': 'rX', Symbol: '' },
    { Symbol: '', 'Asset Type': 'Stock' },
    { Symbol: 'AAPL', 'Asset Type': 'Stock', 'Date Opened': '2026-11-01', Status: 'Open', 'Entry Price': '150', Quantity: '10' }
  ]));
  assert.equal(m.hasTrades, true);
  assert.equal(m.skipped, 1);
  assert.equal(m.trades.length, 1);
  assert.equal(m.trades[0].symbol, 'AAPL');
});

test('tradingModel: the id comes from the Row ID column (blank when the row has none), and inputs are not mutated', () => {
  const m = model(T([
    { 'Row ID': 'T9', Symbol: 'AAPL', 'Entry Price': 1, Quantity: 1 },
    { Symbol: 'MSFT', 'Entry Price': 1, Quantity: 1 }
  ]));
  assert.deepEqual(m.trades.map(t => [t.symbol, t.id, t.row]).sort(), [['AAPL', 'T9', 2], ['MSFT', '', 3]]);
});

test('tradingModel: long stock win with fees; "$1,234.50" style cells and lower-case currency parse', () => {
  const t = model(T([{ Symbol: 'aapl', 'Asset Type': 'Equity', Direction: 'Long', Status: 'Closed', Quantity: '10', 'Entry Price': '$180.00', 'Exit Price': '$190.00', Fees: '2.00', Currency: 'usd', 'Date Opened': '2026-11-01', 'Date Closed': '2026-11-05' }])).trades[0];
  assert.deepEqual([t.symbol, t.assetType, t.direction, t.currency, t.status], ['AAPL', 'Stock', 'Long', 'USD', 'closed']);
  assert.deepEqual([t.cost, t.gross, t.net, t.daysHeld], [1800, 100, 98, 4]);
  assert.equal(t.pnlPct, 98 / 1800);
  const big = model(T([{ Symbol: 'X', Status: 'Closed', Quantity: '1', 'Entry Price': '1,000', 'Exit Price': '$1,234.50' }])).trades[0];
  assert.equal(big.net, 234.5);
});

test('tradingModel: short crypto loss', () => {
  const t = model(T([{ Symbol: 'BTC', 'Asset Type': 'Crypto', Direction: 'Short', Status: 'Exited', Quantity: '0.5', 'Entry Price': '60,000', 'Exit Price': '62,000', Fees: '10', Currency: 'USD' }])).trades[0];
  assert.deepEqual([t.assetType, t.direction, t.cost, t.gross, t.net], ['Crypto', 'Short', 30000, -1000, -1010]);
});

test('tradingModel: options default to a multiplier of 100, an explicit multiplier wins', () => {
  const m = model(T([
    { Symbol: 'SPY', 'Asset Type': 'Option', 'Option Type': 'Call', Strike: '600', Quantity: '2', 'Entry Price': '5.00', 'Exit Price': '8.00', Fees: '5', Status: 'Closed' },
    { Symbol: 'SPX', 'Asset Type': 'Option', Multiplier: '50', Quantity: '1', 'Entry Price': '10.00', 'Exit Price': '15.00', Fees: '5', Status: 'Closed' }
  ]));
  const spy = m.trades.find(t => t.symbol === 'SPY'), spx = m.trades.find(t => t.symbol === 'SPX');
  assert.deepEqual([spy.mult, spy.cost, spy.net, spy.optionType, spy.strike], [100, 1000, 595, 'Call', 600]);
  assert.deepEqual([spx.mult, spx.cost, spx.net], [50, 500, 245]);
});

test('tradingModel: futures with an explicit multiplier', () => {
  const es = model(T([{ Symbol: 'ES', 'Asset Type': 'Future', Multiplier: '50', Direction: 'Long', Status: 'Closed', Quantity: '2', 'Entry Price': '5000', 'Exit Price': '5020', Fees: '10' }])).trades[0];
  assert.deepEqual([es.assetType, es.mult, es.gross, es.net], ['Future', 50, 2000, 1990]);
});

test('tradingModel: an open trade has no P&L and its cost is counted as open capital', () => {
  const m = model(T([{ Symbol: 'NVDA', 'Asset Type': 'Stock', Status: 'Open', Quantity: '10', 'Entry Price': '100', Currency: 'USD' }]));
  assert.equal(m.open.length, 1);
  assert.equal(m.closed.length, 0);
  assert.equal(m.byCurrency.USD.openCost, 1000);
  assert.equal(m.trades[0].net, null);
  assert.equal(m.byCurrency.USD.statCount, 0);
});

test('tradingModel: closed but missing an exit price is listed, counted as incomplete, and left out of the stats', () => {
  const m = model(T([{ Symbol: 'TSLA', Status: 'Closed', 'Entry Price': '200', 'Exit Price': '', Quantity: '1' }]));
  assert.equal(m.incomplete, 1);
  assert.equal(m.closed.length, 1);
  assert.equal(m.byCurrency.CAD.statCount, 0);
  assert.equal(m.byCurrency.CAD.netPnl, 0);
});

test('tradingModel: blank Status with an Exit Price means closed; an exit price of 0 is still an exit price', () => {
  assert.equal(model(T([{ Symbol: 'AMZN', Status: '', 'Entry Price': '140', 'Exit Price': '150', Quantity: '10' }])).trades[0].status, 'closed');
  const z = model(T([{ Symbol: 'GONE', Status: 'Closed', 'Entry Price': '2', 'Exit Price': 0, Quantity: '10' }])).trades[0];
  assert.equal(z.net, -20);
});

test('tradingModel: currencies are never mixed (CAD and USD are separate, most trades first, ties alphabetical)', () => {
  const m = model(T([
    { Symbol: 'SHOP', Currency: 'CAD', Status: 'Closed', 'Entry Price': '100', 'Exit Price': '110', Quantity: '10' },
    { Symbol: 'AAPL', Currency: 'USD', Status: 'Closed', 'Entry Price': '150', 'Exit Price': '170', Quantity: '10' },
    { Symbol: 'MSFT', Currency: 'USD', Status: 'Closed', 'Entry Price': '100', 'Exit Price': '90', Quantity: '1' }
  ]));
  assert.deepEqual(m.currencies, ['USD', 'CAD']);
  assert.equal(m.byCurrency.CAD.netPnl, 100);
  assert.equal(m.byCurrency.USD.netPnl, 190);
  assert.equal(model(T([{ Symbol: 'A', Currency: 'CAD' }, { Symbol: 'B', Currency: 'USD' }])).currencies.join(), 'CAD,USD');
});

test('tradingModel: win rate, profit factor, expectancy, averages, best / worst, drawdown and the cumulative curve (hand-computed)', () => {
  const row = (s, o, c, x) => ({ Symbol: s, Currency: 'CAD', Status: 'Closed', 'Date Opened': o, 'Date Closed': c, 'Entry Price': '100', 'Exit Price': String(x), Quantity: '10', Fees: '0' });
  const st = model(T([row('T1', '2026-11-01', '2026-11-02', 110), row('T2', '2026-11-02', '2026-11-03', 94), row('T3', '2026-11-03', '2026-11-04', 96), row('T4', '2026-11-04', '2026-11-05', 120)])).byCurrency.CAD;
  assert.deepEqual([st.count, st.statCount, st.wins, st.losses, st.flat, st.winRate], [4, 4, 2, 2, 0, 0.5]);
  assert.deepEqual([st.grossProfit, st.grossLoss, st.netPnl, st.avgWin, st.avgLoss, st.profitFactor, st.expectancy], [300, -100, 200, 150, -50, 3, 50]);
  assert.deepEqual([st.best.symbol, st.worst.symbol, st.maxDrawdown], ['T4', 'T2', 100]);
  assert.deepEqual(st.curve.map(c => c.cum), [100, 40, 0, 200]);
});

test('tradingModel: profit factor is null with no losses, fees are summed, byAsset only lists asset types that exist', () => {
  const st = model(T([{ Symbol: 'AAPL', 'Asset Type': 'Stock', Status: 'Closed', 'Entry Price': '100', 'Exit Price': '110', Quantity: '1', Fees: '1.5' }])).byCurrency.CAD;
  assert.equal(st.profitFactor, null);
  assert.equal(st.fees, 1.5);
  assert.equal(st.avgLoss, null);
  assert.deepEqual(Object.keys(st.byAsset), ['Stock']);
  assert.deepEqual(st.byAsset.Stock, { count: 1, closed: 1, net: 8.5, winRate: 1 });
});

test('tradingModel: newest first by opened date, undated last, ties by the lower sheet row last', () => {
  const m = model(T([
    { Symbol: 'OLD', 'Date Opened': '2026-10-01' }, { Symbol: 'NODATE' }, { Symbol: 'NEW', 'Date Opened': '2026-11-09' }
  ]));
  assert.deepEqual(m.trades.map(t => t.symbol), ['NEW', 'OLD', 'NODATE']);
});

test('preIpoModel: a missing tab gives an empty model; spare rows ignored; no Company is skipped; the id is the Row ID', () => {
  for (const raw of [null, {}, { PreIPO: {} }]) {
    const m = ipo(raw);
    assert.equal(m.hasPre, false);
    assert.deepEqual([m.items, m.active, m.done], [[], [], []]);
    assert.equal(m.skipped, 0);
  }
  const m = ipo(P([{ Company: null }, { Timestamp: '2026-11-10', 'Row ID': 'p0' }, { Ticker: 'XYZ' }, { 'Row ID': 'P7', Company: 'Anthropic', Ticker: 'ant', Status: 'Bid placed' }]));
  assert.equal(m.skipped, 1);
  assert.deepEqual(m.items.map(i => [i.company, i.ticker, i.id]), [['Anthropic', 'ANT', 'P7']]);
});

test('preIpoModel: stages, next date, cost fallback, gain, ordering and totals by currency (hand-computed, today = 11 Nov 2026)', () => {
  const m = ipo(P([
    { Company: 'Stripe', Status: 'Submitted', 'Bid Closes': '2026-11-15', 'Shares Requested': '100', 'Price Low': '20', 'Price High': '30', Currency: 'USD' },
    { Company: 'Databricks', Status: 'Pending', 'Bid Closes': '2026-11-05', 'IPO Date': '2026-11-20', 'Shares Requested': '50', 'Price Low': '40', 'Price High': '50', Currency: 'USD' },
    { Company: 'SpaceX', Status: 'Allocated', 'Shares Allocated': '20', 'Final Price': '100', 'Current Price': '150', 'Lockup Expiry': '2026-12-01', Currency: 'USD' },
    { Company: 'Arm', Status: 'Listed', 'Shares Allocated': '10', 'Cost Basis': '500', 'Current Price': '80', 'Lockup Expiry': '2026-11-25', Currency: 'USD' },
    { Company: 'Reddit', Status: 'Trading', 'Shares Allocated': '10', 'Cost Basis': '400', 'Current Price': '60', 'Lockup Expiry': '2026-10-01', Currency: 'USD' },
    { Company: 'Discord', Status: 'Withdrawn', 'Date Submitted': '2026-01-01', Currency: 'USD' },
    { Company: 'Figma', Status: 'Not allocated', 'Date Submitted': '2026-05-01', Currency: 'USD' }
  ]));
  const by = c => m.items.find(i => i.company === c);
  assert.deepEqual(m.active.map(i => i.company), ['Stripe', 'Databricks', 'Arm', 'SpaceX']);
  assert.deepEqual(m.done.map(i => i.company), ['Figma', 'Discord', 'Reddit']);
  assert.deepEqual([by('Stripe').stage, by('Databricks').stage, by('SpaceX').stage, by('Arm').stage, by('Reddit').stage, by('Discord').stage, by('Figma').stage],
    ['bidding', 'awaiting', 'allocated', 'listed', 'listed', 'cancelled', 'not-allocated']);
  assert.deepEqual([by('Stripe').next.label, by('Stripe').next.days], ['Bid window closes', 4]);
  assert.deepEqual([by('Databricks').next.label, by('Databricks').next.days], ['IPO day', 9]);
  assert.deepEqual([by('SpaceX').next.label, by('SpaceX').next.days], ['Lockup expires', 20]);
  assert.equal(by('Discord').next, null);
  assert.deepEqual([by('Stripe').estLow, by('Stripe').estHigh], [2000, 3000]);
  const sx = by('SpaceX');
  assert.deepEqual([sx.cost, sx.value, sx.gain, sx.gainPct], [2000, 3000, 1000, 0.5]);
  assert.equal(m.totals.pendingCount, 2);
  assert.equal(m.totals.allocatedCount, 3);
  assert.deepEqual(m.totals.byCurrency.USD, { reservedLow: 4000, reservedHigh: 5500, holdingsCost: 2900, holdingsValue: 4400, gain: 1500 });
});

test('preIpoModel: a bid with no dates is "bidding", currency defaults to USD, and a different currency gets its own totals', () => {
  const m = ipo(P([
    { Company: 'A', Status: '', 'Shares Requested': '2', 'Price Low': '70', 'Price High': '78' },
    { Company: 'B', Status: 'Bid placed', 'Shares Requested': '10', 'Price Low': '5', 'Price High': '6', Currency: 'CAD' }
  ]));
  assert.equal(m.items.find(i => i.company === 'A').stage, 'bidding');
  assert.equal(m.items.find(i => i.company === 'A').currency, 'USD');
  assert.deepEqual(Object.keys(m.totals.byCurrency).sort(), ['CAD', 'USD']);
  assert.equal(m.totals.byCurrency.USD.reservedLow, 140);
  assert.equal(m.totals.byCurrency.CAD.reservedHigh, 60);
});

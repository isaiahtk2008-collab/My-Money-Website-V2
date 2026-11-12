// Run with: node --test tests/trading-screens.test.mjs
// The Trading screen and the Pre-IPO card (index.html), as pure functions: model in, HTML string out.
// Loads the REAL functions out of index.html. Only the shared card() and kpi() helpers are stubbed so the checks stay about OUR text.
// Proves: missing tabs show the setup note (with the exact header row), nothing from the sheet can inject HTML, lists are NEWEST first,
// rows without a Row ID cannot be edited, currencies never mix, and odd data never throws.
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

const consts = ['sod', 'DAY', 'TODAY', 'diffD', 'pd', 'num', 'sum', 'esc', 'pct', 'MO', 'fd', 'fdy', 'TRADES_HEADERS', 'PREIPO_HEADERS'].map(constLine);
const funcs = ['trStr', 'trBlankRow', 'trAsset', 'trDir', 'trStatus', 'tradingModel', 'ipoStage', 'ipoNext', 'preIpoModel',
  'trMoney', 'trPnlSpan', 'trPlural', 'trScriptDiag', 'trPreTab', 'trRowStyle', 'ipoStageChip', 'ipoNextText', 'tradingScreenHtml', 'preIpoCardHtml'].map(fnBlock);
const stubs = `function card(t,b,r){return '[CARD '+t+(r?'|'+r:'')+']'+b}
function kpi(o){return '[KPI '+o.label+'|'+o.val+'|'+(o.sub||'')+(o.spark?'|spark'+o.spark.length:'')+']'}`;
const ctx = vm.createContext({ Intl, Math, Date, Set, Map, Array, Object, JSON, Number, String, RegExp, console });
vm.runInContext([...consts, stubs, ...funcs, 'globalThis.__t={tradingModel,preIpoModel,tradingScreenHtml,preIpoCardHtml,trMoney};'].join('\n'), ctx);
const { tradingModel, preIpoModel, tradingScreenHtml, preIpoCardHtml, trMoney } = ctx.__t;

const NOW = new Date(2026, 10, 11);
const T = rows => ({ Trades: { rows: rows.map((r, i) => Object.assign({ _row: i + 2 }, r)) } });
const P = rows => ({ PreIPO: { rows: rows.map((r, i) => Object.assign({ _row: i + 2 }, r)) } });
const screen = (raw, o) => tradingScreenHtml(tradingModel(raw, NOW), o);
const card = raw => preIpoCardHtml(preIpoModel(raw, NOW));

test('trMoney: currency symbols, minus sign in front, two decimals, dash for nothing', () => {
  assert.equal(trMoney(1234.5, 'CAD'), 'C$1,234.50');
  assert.equal(trMoney(-1234.5, 'USD'), '-US$1,234.50');
  assert.equal(trMoney(5, 'EUR'), 'EUR 5.00');
  assert.equal(trMoney(null, 'CAD'), '—');
  assert.equal(trMoney(NaN, 'CAD'), '—');
});

test('Trading screen: a missing Trades tab shows the setup note with the exact header row; an empty tab invites the first trade', () => {
  for (const raw of [null, {}]) {
    const h = tradingScreenHtml(tradingModel(raw, NOW), {});
    assert.ok(h.includes('One tab to add first') && h.includes('Trades'));
    assert.ok(h.includes('Timestamp\tRow ID\tDate Opened\tAsset Type\tSymbol'));
  }
  const h = screen({ Trades: { rows: [] } });
  assert.ok(h.includes('No trades yet') && !h.includes('data-id="trade"') && h.includes('Tap +'));
});

test('Trading screen: KPIs, open positions and closed trades render for the selected currency; the equity curve feeds the Net P&L spark', () => {
  const raw = T([
    { 'Row ID': 'T1', Symbol: 'AAPL', 'Asset Type': 'Stock', Direction: 'Long', Status: 'Open', Quantity: 10, 'Entry Price': 180, Currency: 'USD', 'Date Opened': '2026-11-01' },
    { 'Row ID': 'T2', Symbol: 'ETH', 'Asset Type': 'Crypto', Direction: 'Long', Status: 'Closed', Quantity: 2, 'Entry Price': 3000, 'Exit Price': 3300, Fees: 4, Currency: 'USD', 'Date Opened': '2026-10-01', 'Date Closed': '2026-10-05' },
    { 'Row ID': 'T3', Symbol: 'BTC', 'Asset Type': 'Crypto', Direction: 'Short', Status: 'Closed', Quantity: 1, 'Entry Price': 60000, 'Exit Price': 61000, Currency: 'USD', 'Date Opened': '2026-10-10', 'Date Closed': '2026-10-12' }
  ]);
  const h = screen(raw, { cur: 'USD' });
  assert.ok(h.includes('[KPI Net P&L|<span style="color:var(--bad)">-US$404.00</span>|2 closed trades|spark2]'), h.slice(0, 600));   // +596 (ETH) and -1000 (BTC short)
  assert.ok(h.includes('[KPI Win rate|50%|1W · 1L]'));
  assert.ok(h.includes('[KPI Open capital|US$1,800.00|1 open position]'));
  assert.ok(h.includes('data-trade-edit="T1">Close / edit'));
  assert.ok(h.includes('data-trade-edit="T2">Edit') && h.includes('data-trade-edit="T3">Edit'));
  assert.ok(h.includes('By asset type'));
});

test('Trading screen: rows are NEWEST first (open and closed), most recent 25 closed trades only', () => {
  const rows = [];
  for (let i = 1; i <= 30; i++) rows.push({ 'Row ID': 'C' + i, Symbol: 'S' + String(i).padStart(2, '0'), Status: 'Closed', Quantity: 1, 'Entry Price': 10, 'Exit Price': 11, 'Date Opened': '2026-10-' + String(i).padStart(2, '0') });
  const h = screen(T(rows));
  const syms = [...h.matchAll(/<b>(S\d\d)<\/b>/g)].map(x => x[1]);
  assert.equal(syms.length, 25);
  assert.equal(syms[0], 'S30');
  assert.equal(syms[24], 'S06');
  assert.ok(!h.includes('<b>S05</b>'));
});

test('Trading screen: a row with no Row ID cannot be edited; a closed trade with no exit is flagged and explained', () => {
  const h = screen(T([
    { Symbol: 'NOID', Status: 'Open', Quantity: 1, 'Entry Price': 5 },
    { 'Row ID': 'X1', Symbol: 'HALF', Status: 'Closed', Quantity: 1, 'Entry Price': 5 }
  ]));
  assert.ok(h.includes('Needs a Row ID'));
  assert.ok(h.includes('Needs entry and exit'));
  assert.ok(h.includes('1 closed trade is missing an entry or exit price, so it is left out of the stats.'));
  assert.ok(!h.includes('data-trade-edit=""'));
});

test('Trading screen: two currencies get a switch and are never mixed', () => {
  const raw = T([
    { 'Row ID': 'A', Symbol: 'SHOP', Currency: 'CAD', Status: 'Closed', Quantity: 1, 'Entry Price': 100, 'Exit Price': 150 },
    { 'Row ID': 'B', Symbol: 'AAPL', Currency: 'USD', Status: 'Closed', Quantity: 1, 'Entry Price': 100, 'Exit Price': 110 },
    { 'Row ID': 'C', Symbol: 'MSFT', Currency: 'USD', Status: 'Closed', Quantity: 1, 'Entry Price': 100, 'Exit Price': 120 }
  ]);
  const usd = screen(raw, {});               // USD has the most trades, so it is the default
  assert.ok(usd.includes('data-trading-cur="USD" aria-pressed="true"') && usd.includes('data-trading-cur="CAD" aria-pressed="false"'));
  assert.ok(usd.includes('+US$30.00') && !usd.includes('SHOP'));
  const cad = screen(raw, { cur: 'CAD' });
  assert.ok(cad.includes('+C$50.00') && cad.includes('SHOP') && !cad.includes('AAPL'));
  assert.ok(screen(raw, { cur: 'JPY' }).includes('+US$30.00'));   // an unknown currency falls back to the first
  assert.ok(!screen(T([{ Symbol: 'ONE', Currency: 'CAD' }])).includes('data-trading-cur'));   // one currency: no switch
});

test('Trading screen: nothing from the sheet can inject HTML', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const h = screen(T([{ 'Row ID': '"><b>', Symbol: evil, 'Asset Type': evil, Strategy: evil, 'Option Type': evil, Status: 'Open', Quantity: 1, 'Entry Price': 1, Currency: evil }]));
  assert.ok(!h.includes('<img'));
  assert.ok(h.includes('data-trade-edit="&quot;&gt;&lt;b&gt;"'), 'the hostile Row ID must arrive as an escaped attribute value');
  assert.ok(!/data-trade-edit="[^"]*[<>][^"]*"/.test(h));
  assert.ok(h.includes('&lt;IMG SRC=X ONERROR=ALERT(1)&gt;'));
});

test('Pre-IPO card: a missing tab shows the setup note; an empty tab invites the first bid', () => {
  for (const raw of [null, {}]) { const h = card(raw); assert.ok(h.includes('One tab to add first') && h.includes('Pre-IPO') && h.includes('Timestamp\tRow ID\tCompany\tTicker')); }
  const h = card({ PreIPO: { rows: [] } });
  assert.ok(h.includes('No IPO bids yet') && h.includes('data-lg="open" data-id="ipo"'));
});

test('Pre-IPO card: a pending bid shows the reserved range, the next date, the "not guaranteed" note and an Update button', () => {
  const h = card(P([{ 'Row ID': 'P1', Company: 'Anthropic', Ticker: 'ant', Account: 'TFSA', Status: 'Bid placed', 'Date Submitted': '2026-11-10', 'Bid Closes': '2026-11-18', 'IPO Date': '2026-11-30', 'Shares Requested': 2, 'Price Low': 70, 'Price High': 78 }]));
  assert.ok(h.includes('<b>Anthropic</b> <span class="chip">ANT</span> <span class="chip warn">Bid open</span>'));
  assert.ok(h.includes('TFSA · requested 2 sh · US$70.00–US$78.00 · Bid window closes in 7 days'));
  assert.ok(h.includes('USD: Reserved US$140.00–US$156.00 (pending bids)'));
  assert.ok(h.includes('Bids are requests, not guaranteed'));
  assert.ok(h.includes('data-ipo-edit="P1">Update'));
});

test('Pre-IPO card: an allocated holding shows its gain; a bid with no Row ID cannot be updated; closed ones are newest first', () => {
  const h = card(P([
    { 'Row ID': 'P2', Company: 'Held Co', Status: 'Allocated', 'Shares Allocated': 20, 'Final Price': 100, 'Current Price': 150, 'Lockup Expiry': '2026-12-01' },
    { Company: 'NoId Co', Status: 'Bid placed', 'Shares Requested': 1 },
    { 'Row ID': 'P3', Company: 'Old Co', Status: 'Cancelled', 'Date Submitted': '2026-01-01' },
    { 'Row ID': 'P4', Company: 'Newer Co', Status: 'Not allocated', 'Date Submitted': '2026-06-01' }
  ]));
  assert.ok(h.includes('+US$1,000.00') && h.includes('50.0%'));
  assert.ok(h.includes('Holdings US$3,000.00 on US$2,000.00 cost (+US$1,000.00)'));
  assert.ok(h.includes('Needs a Row ID'));
  assert.ok(h.indexOf('Newer Co') < h.indexOf('Old Co'));
  assert.ok(h.includes('Closed (2)'));
});

test('Pre-IPO card: nothing from the sheet can inject HTML', () => {
  const evil = '<script>alert(1)</script>';
  const h = card(P([{ 'Row ID': '"><i>', Company: evil, Ticker: evil, Account: evil, Status: 'Bid placed', Currency: 'USD' }]));
  assert.ok(!h.includes('<script'));
  assert.ok(h.includes('data-ipo-edit="&quot;&gt;&lt;i&gt;"'), 'the hostile Row ID must arrive as an escaped attribute value');
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('both screens never throw on odd data', () => {
  const weird = [{}, { Symbol: 5 }, { Symbol: 'X', 'Entry Price': 'abc', Quantity: {}, 'Date Opened': 'not a date' }, { Symbol: 'Y', Status: 'Closed', 'Entry Price': 0, 'Exit Price': 0, Quantity: 0 }];
  assert.doesNotThrow(() => screen(T(weird)));
  assert.doesNotThrow(() => card(P([{}, { Company: 'Z', 'Bid Closes': 'garbage', 'Shares Requested': 'x' }, { Company: 'Q', Status: 'listed', 'Lockup Expiry': 'nope' }])));
});

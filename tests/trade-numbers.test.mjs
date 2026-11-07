// Run with: node --test tests/trade-numbers.test.mjs
// Trade numbers on the dashboard (index.html). Loads the REAL functions out of index.html (no copies) and proves:
//  - rows with no trade columns (or blank Source / Payment Type) give exactly the numbers the original code gave (snapshot in fixtures/trade-golden.json)
//  - a cash sale, a mixed trade sale and a trade-in flip give the expected profit, cash spent and trade value
//  - cash spent is REAL cash only; trade-in value is kept on its own line and never added to cash or to Expenses
//  - the Trade badge / cost helpers, the Trades-only filter and the margin calculator's trade-in field behave
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const golden = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'trade-golden.json'), 'utf8'));
function constLine(n) { const m = html.match(new RegExp('^const ' + n + '=', 'm')); if (!m) throw new Error('const ' + n + ' missing'); const lines = html.slice(m.index).split('\n'); let code = ''; for (const l of lines) { code += (code ? '\n' : '') + l; try { new Function(code); return code; } catch (e) {} } throw new Error('const ' + n + ' unparsable'); }
function fnBlock(name) { const s = html.indexOf('function ' + name + '('); if (s < 0) throw new Error('fn ' + name + ' missing'); let i = html.indexOf('{', html.indexOf(')', s)), d = 0; for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (!d) return html.slice(s, i + 1); } } throw new Error('unbalanced ' + name); }
const consts = ['esc','nf0','nf2','mny','M','sgn','SM','pct','sum','avg','median','groupBy','plural','num','MO','DOW','DAY','sod','TODAY','addD','diffD','fd','fdy','dkey','pd','inR','clean','numOf','CAT_MAP','TYPE_MAP'].map(constLine);
const funcs = ['canonCondition','canonRam','normalize','inventoryStats','tradeFields','tradeSplit','tradeBadge','costCell','tradeLines','tradeCalc','calcUpdate','itemRows'].map(fnBlock);
const ctx = vm.createContext({ Intl, Math, Date, Set, Map, Array, Object, JSON, Number, String, RegExp, console });
vm.runInContext([...consts, ...funcs, 'globalThis.__t={normalize,inventoryStats,tradeFields,tradeSplit,tradeBadge,costCell,tradeLines,tradeCalc,calcUpdate,itemRows,M};'].join('\n'), ctx);
const T = ctx.__t;
// Objects created inside the vm context have a different Object prototype; copy to plain JSON before deepEqual.
const plain = x => JSON.parse(JSON.stringify(x));

function calc(vals) { const els = {}; for (const k of Object.keys(vals)) els['#' + k] = { value: vals[k] }; els['#mc-out'] = { innerHTML: '' }; ctx.$ = s => els[s] || null; vm.runInContext('calcUpdate()', ctx); return els['#mc-out'].innerHTML; }

const PLAIN_RAW = {
  Expenses: { rows: [{ 'Item Purchased': 'Cash toward iPad', Category: 'Electronics', Establishment: 'Marketplace', 'Date of Purchase': '2026-09-10', Amount: 50 }] },
  Phones: { rows: [
    { Model: 'iPhone 11', Status: 'SOLD', 'Purchase Price': 300, 'Purchase Date': '2026-08-01', 'Sale Price': 420, 'Sale Date': '2026-08-10', 'Sold To': 'Sam' },
    { Model: 'Galaxy S21', Status: 'SOLD', 'Purchase Price': 400, 'Purchase Date': '2026-08-20', 'Sale Price': 600, 'Sale Date': '2026-09-05' },
    { Model: 'Pixel 6', Status: 'IN INVENTORY', 'Purchase Price': 250, 'Purchase Date': '2026-09-05' } ] },
  PCs: { rows: [{ 'PC model': 'Dell Optiplex', Status: 'IN INVENTORY', 'Purchase Price': 120, 'Purchase Date': '2026-07-15' }] },
  Accessories: { rows: [{ Brand: 'Apple', Model: 'AirPods', 'Item Type': 'Earbuds', Status: 'SOLD', 'Purchase Price': 80, 'Purchase Date': '2026-08-05', 'Sale Price': 110, 'Sale Date': '2026-08-12' }] },
};
const TRADE_RAW = {
  Expenses: { rows: [{ 'Item Purchased': 'Cash toward iPad', Category: 'Electronics', Establishment: 'Marketplace', 'Date of Purchase': '2026-09-10', Amount: 50 }] },
  Phones: { rows: [
    { Model: 'iPhone 11', Status: 'SOLD', 'Purchase Price': 300, 'Purchase Date': '2026-08-01', 'Sale Price': 420, 'Sale Date': '2026-08-10' },
    { Model: 'Galaxy S21', Status: 'SOLD', 'Purchase Price': 400, 'Purchase Date': '2026-08-20', 'Sale Price': 600, 'Sale Date': '2026-09-05', 'Payment Type': 'Mixed', 'Trade ID': 'T-1001' },
    { Model: 'Pixel 6', Status: 'SOLD', Source: 'Trade-in', 'Trade ID': 'T-1001', 'Cash Paid': 0, 'Purchase Price': 250, 'Purchase Date': '2026-09-05', 'Sale Price': 330, 'Sale Date': '2026-09-20' },
    { Model: 'iPad', Status: 'IN INVENTORY', Source: 'Trade-in', 'Trade ID': 'T-1002', 'Cash Paid': 50, 'Purchase Price': 200, 'Purchase Date': '2026-09-10' } ] },
  Accessories: { rows: [{ Brand: 'Apple', Model: 'AirPods', 'Item Type': 'Earbuds', Status: 'IN INVENTORY', 'Purchase Price': 80, 'Date Purchased': '2026-09-01' }] },
};

test('plain rows: every existing number is unchanged (snapshot vs the original code)', () => {
  const D = T.normalize(PLAIN_RAW);
  const st = T.inventoryStats(D);
  const snapshot = {
    items: D.items.map(i => ({
      name: i.name,
      kind: i.kind,
      sold: i.sold,
      buyPrice: i.buyPrice,
      sellPrice: i.sellPrice,
      profit: i.profit,
      roi: i.roi,
      days: i.days
    })),
    expensesTotal: D.expenses.reduce((s, e) => s + e.amount, 0),
    stockCost: st.cost,
    stockCount: st.stock.length,
    issues: D.issues.length
  };
  assert.deepEqual(plain(snapshot), golden.plain);

  for (const item of D.items) {
    assert.equal(item.cashSpent, item.buyPrice);
    assert.equal(item.tradeValue, 0);
    assert.equal(item.isTrade, false);
    assert.equal(item.source, 'Purchase');
    assert.equal(item.payType, 'Cash');
    assert.equal(item.tradeId, null);
  }
  assert.equal(st.cash, st.cost);
  assert.equal(st.tradeValue, 0);
});

test('blank or whitespace Source/Payment Type stay plain, and Cash Paid is ignored unless it is a trade-in', () => {
  const res = T.tradeFields({ Source: '   ', 'Payment Type': '', 'Cash Paid': 10 }, 100);
  assert.equal(res.cashSpent, 100);
  assert.equal(res.tradeValue, 0);
  assert.equal(res.isTrade, false);
  assert.equal(res.source, 'Purchase');
  assert.equal(res.payType, 'Cash');

  const resNull = T.tradeFields({}, null);
  assert.equal(resNull.cashSpent, null);
  assert.equal(resNull.tradeValue, null);
  assert.equal(resNull.isTrade, false);
});

test('cash sale', () => {
  const D = T.normalize(TRADE_RAW);
  const item = D.items.find(i => i.name === 'iPhone 11');
  assert.equal(item.profit, 120);
  assert.equal(item.roi, 0.4);
  assert.equal(item.cashSpent, 300);
  assert.equal(item.tradeValue, 0);
  assert.equal(item.isTrade, false);
});

test('mixed trade sale', () => {
  const D = T.normalize(TRADE_RAW);
  const item = D.items.find(i => i.name === 'Galaxy S21');
  assert.equal(item.profit, 200);
  assert.equal(item.roi, 0.5);
  assert.equal(item.isTradeSale, true);
  assert.equal(item.isTradeIn, false);
  assert.equal(item.isTrade, true);
  assert.equal(item.tradeId, 'T-1001');
  assert.equal(item.payType, 'Mixed');
  assert.equal(item.cashSpent, 400);
  assert.equal(item.tradeValue, 0);
});

test('trade-in flip', () => {
  const D = T.normalize(TRADE_RAW);
  const item = D.items.find(i => i.name === 'Pixel 6');
  assert.equal(item.isTradeIn, true);
  assert.equal(item.source, 'Trade-in');
  assert.equal(item.cashSpent, 0);
  assert.equal(item.tradeValue, 250);
  assert.equal(item.buyPrice, 250);
  assert.equal(item.profit, 80);
  assert.equal(item.roi, 0.32);
});

test('trade-in with partial cash, and Cash Paid is clamped', () => {
  const D = T.normalize(TRADE_RAW);
  const item = D.items.find(i => i.name === 'iPad');
  assert.equal(item.cashSpent, 50);
  assert.equal(item.tradeValue, 150);

  const clampedHigh = T.tradeFields({ Source: 'Trade-in', 'Cash Paid': 500 }, 200);
  assert.equal(clampedHigh.cashSpent, 200);
  assert.equal(clampedHigh.tradeValue, 0);

  const clampedLow = T.tradeFields({ Source: 'Trade-in', 'Cash Paid': -5 }, 200);
  assert.equal(clampedLow.cashSpent, 0);
  assert.equal(clampedLow.tradeValue, 200);
});

test('cash spent and trade value are kept apart', () => {
  const D = T.normalize(TRADE_RAW);
  const sumCashSpent = D.items.reduce((s, i) => s + i.cashSpent, 0);
  const sumBuyPrice = D.items.reduce((s, i) => s + i.buyPrice, 0);
  const sumTradeValue = D.items.reduce((s, i) => s + i.tradeValue, 0);

  assert.equal(sumCashSpent, 830);
  assert.equal(sumBuyPrice, 1230);
  assert.equal(sumTradeValue, 400);

  for (const item of D.items) {
    assert.equal(item.cashSpent + item.tradeValue, item.buyPrice);
  }

  const expTotal = D.expenses.reduce((s, e) => s + e.amount, 0);
  assert.equal(expTotal, 50);

  const st = T.inventoryStats(D);
  assert.equal(st.cost, 280);
  assert.equal(st.cash, 130);
  assert.equal(st.tradeValue, 150);

  assert.deepEqual(plain(T.tradeSplit(D.items)), { cash: 830, trade: 400 });
  assert.deepEqual(plain(T.tradeSplit([])), { cash: 0, trade: 0 });
  assert.deepEqual(plain(T.tradeSplit(undefined)), { cash: 0, trade: 0 });
});

test('badge and cost helpers', () => {
  const D = T.normalize(TRADE_RAW);
  const iphone = D.items.find(i => i.name === 'iPhone 11');
  const pixel = D.items.find(i => i.name === 'Pixel 6');
  const ipad = D.items.find(i => i.name === 'iPad');

  assert.equal(T.tradeBadge(iphone), '');
  assert.equal(T.tradeBadge(pixel).includes('pill acc'), true);
  assert.equal(T.tradeBadge(pixel).includes('Trade ID T-1001'), true);

  const injectedBadge = T.tradeBadge({ isTrade: true, tradeId: '<img src=x onerror=1>' });
  assert.equal(injectedBadge.includes('<img'), false);

  assert.equal(T.costCell(iphone), T.M(300));
  assert.equal(T.costCell(ipad).includes('Cash spent'), true);
  assert.equal(T.costCell(ipad).includes('Trade value received'), true);

  assert.equal(T.tradeLines(130, 0), '');
  assert.equal(T.tradeLines(130, 150).includes('Cash spent'), true);
  assert.equal(T.tradeLines(130, 150).includes('Trade value received'), true);
});

test('Trades-only filter keeps only trade deals', () => {
  const D = T.normalize(TRADE_RAW);
  ctx.store = { D };
  ctx.RG = () => ({ start: new Date(2000, 0, 1), end: new Date(2100, 0, 1) });
  ctx.S = { kind: 'All', rstat: 'All', rtrade: 'All' };

  const allNames = T.itemRows();
  assert.equal(allNames.length, 5);

  ctx.S.rtrade = 'Trade';
  const tradeNames = T.itemRows().map(i => i.name).sort();
  assert.deepEqual(plain(tradeNames), ['Galaxy S21', 'Pixel 6', 'iPad']);
});

test('calculator: unchanged when the trade-in field is empty', () => {
  const cases = [
    { input: { 'mc-cost': '100', 'mc-tgt': '25', 'mc-fee': '0', 'mc-ext': '0' }, goldenIdx: 0 },
    { input: { 'mc-cost': '250', 'mc-tgt': '30', 'mc-fee': '13', 'mc-ext': '15' }, goldenIdx: 1 },
    { input: { 'mc-cost': '', 'mc-tgt': '25', 'mc-fee': '0', 'mc-ext': '0' }, goldenIdx: 2 }
  ];

  for (const { input, goldenIdx } of cases) {
    const expected = golden.calc[goldenIdx];
    assert.equal(calc({ ...input }), expected);
    assert.equal(calc({ ...input, 'mc-trade': '' }), expected);
    assert.equal(calc({ ...input, 'mc-trade': '0' }), expected);
  }
});

test('calculator: tradeCalc numbers', () => {
  assert.deepEqual(plain(T.tradeCalc(300, 1, 25, 100)), {
    trade: 100,
    list: 375,
    profit: 75,
    cashAtList: 275,
    floorPrice: 390,
    cashForFloor: 290,
    coveredByTrade: false
  });

  assert.deepEqual(plain(T.tradeCalc(300, 0.9, 25, 500)), {
    trade: 500,
    list: 417,
    profit: 75.3,
    cashAtList: 0,
    floorPrice: 433.34,
    cashForFloor: 0,
    coveredByTrade: true
  });
});

test('calculator: with a trade-in value it adds profit and the 30% ROI-floor cash', () => {
  const out = calc({ 'mc-cost': '100', 'mc-tgt': '25', 'mc-fee': '0', 'mc-ext': '0', 'mc-trade': '100' });
  assert.equal(out.startsWith(golden.calc[0]), true);
  assert.equal(out.includes('Trade-in value:'), true);
  assert.equal(out.includes('Cash to collect at the list price: <b><span class="amt">$25</span></b>'), true);
  assert.equal(out.includes('Cash needed to keep a 30% ROI floor: <b><span class="amt">$30</span></b>'), true);
  assert.equal(out.includes('Profit on the sale'), true);

  const out2 = calc({ 'mc-cost': '100', 'mc-tgt': '25', 'mc-fee': '0', 'mc-ext': '0', 'mc-trade': '500' });
  assert.equal(out2.includes('(the trade-in alone covers it)'), true);
  assert.equal(out2.includes('Cash needed to keep a 30% ROI floor: <b><span class="amt">$0</span></b>'), true);
});

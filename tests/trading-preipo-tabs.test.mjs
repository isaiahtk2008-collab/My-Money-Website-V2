// Run with: node tests/trading-preipo-tabs.test.mjs
// Proves the new "Trades" and "Pre-IPO" tabs in apps-script.gs behave exactly like the "Owed" tab: rows can be added and edited (by Row ID,
// logged to the Edit Log) but never deleted, a missing tab is reported missing and is never created, retries add nothing,
// guests never see them, and no other tab is ever touched.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { authWrap } from './helpers/gs-auth.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'apps-script.gs'), 'utf8');

function makeSheet(name, grid, formulas = {}, maxRows = grid.length) {
  const writes = [], deleted = [], inserted = [], appended = [];
  const sheet = {
    name, grid, formulas, writes, deleted, inserted, appended, maxRows,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max(0, ...grid.map(r => r.length)),
    getMaxRows: () => sheet.maxRows,
    insertRowsAfter: (after, n) => { inserted.push([after, n]); for (let i = 0; i < n; i++) grid.push([]); sheet.maxRows += n; },
    deleteRow: r => { deleted.push(r); grid.splice(r - 1, 1); sheet.maxRows -= 1; },
    appendRow: row => { if (sheet.failAppend) throw new Error('boom'); appended.push(row); grid.push(row.slice()); },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (grid[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
        getFormula: () => formulas[r + ',' + c] || '',
        getValue: () => { const v = (grid[r - 1] || [])[c - 1]; return v === undefined ? '' : v; },
        setValue: v => { writes.push([r, c, v]); while (grid.length < r) grid.push([]); grid[r - 1][c - 1] = v; },
        setValues: vals => { vals.forEach((rowVals, i) => rowVals.forEach((v, j) => { while (grid.length < r + i) grid.push([]); grid[r - 1 + i][c - 1 + j] = v; })); writes.push(['setValues', r, c]); }
      };
    }
  };
  return sheet;
}

function load(sheets, opts = {}) {
  const props = {}, cache = {}, createdNames = [];
  const ss = {
    getSheets: () => sheets,
    getSpreadsheetTimeZone: () => 'UTC',
    insertSheet: name => {
      if (opts.failInsert) throw new Error('nope');
      const s = makeSheet(name, []);
      sheets.push(s);
      createdNames.push(name);
      return s;
    }
  };
  const ctx = {
    console,
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType(m) { this.mime = m; return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString().slice(11, 19)) }
  };
  vm.createContext(ctx);
  ctx.__created = createdNames;
  vm.runInContext(code, ctx);
  authWrap(ctx);
  return ctx;
}

const parse = out => { assert.equal(out.mime, 'JSON'); return JSON.parse(out.text); };
const post = (ctx, body) => parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }));
const get = (ctx, parameter) => parse(ctx.doGet({ parameter }));
const snap = sheet => JSON.stringify(sheet.grid);

const LOG_HEAD = ['Timestamp', 'Tab', 'Row ID', 'Column', 'Old value', 'New value', 'Action'];
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';
const byName = (sheets, name) => sheets.find(s => s.name === name);
const snapAll = sheets => sheets.map(s => snap(s));
const unchanged = (sheets, before) => sheets.forEach((s, i) => assert.equal(snap(s), before[i]));

// ---- Trades + Pre-IPO tab tests (drafted by Gemini 3.5 flash, then reviewed and corrected: real edit/delete/read request shapes, real helper use) ----
const TRADES_HEAD = ['Timestamp', 'Row ID', 'Date Opened', 'Asset Type', 'Symbol', 'Direction', 'Status', 'Quantity', 'Entry Price', 'Exit Price', 'Fees', 'Currency', 'Multiplier', 'Option Type', 'Strike', 'Expiry', 'Strategy', 'Date Closed', 'Notes'];
const PRE_HEAD = ['Timestamp', 'Row ID', 'Company', 'Ticker', 'Account', 'Status', 'Date Submitted', 'Bid Closes', 'IPO Date', 'Lockup Expiry', 'Shares Requested', 'Shares Allocated', 'Price Low', 'Price High', 'Final Price', 'Currency', 'Cost Basis', 'Current Price', 'Notes'];

const makeTT = (opts = {}) => {
  const sheets = [];
  if (!opts.noTrades) {
    sheets.push(makeSheet('Trades', [
      TRADES_HEAD,
      ['', 'T1', '2026-11-01', 'Stock', 'AAPL', 'Long', 'Open', 10, 180, '', 1, 'USD', '', '', '', '', 'Breakout', '', 'first trade'],
      ['', 'T2', '2026-11-02', 'Crypto', 'ETH', 'Long', 'Open', 2, 3000, '', 4, 'USD', '', '', '', '', 'Dip buy', '', '']
    ]));
  }
  if (!opts.noPre) {
    sheets.push(makeSheet('Pre-IPO', [
      PRE_HEAD,
      ['', 'P1', 'Anthropic', 'ANT', 'TFSA', 'Bid placed', '2026-11-10', '2026-11-18', '2026-11-30', '', 2, '', 70, 78, '', 'USD', '', '', '']
    ]));
  }
  sheets.push(makeSheet('Expenses', [
    ['Timestamp', 'Row ID', 'Item Purchased', 'Amount', 'Date of Purchase', 'Establishment'],
    ['', 'E1', 'Tape', 10, '2026-01-01', 'Store']
  ]));
  sheets.push(makeSheet('Master Inventory', [
    ['Timestamp', 'Row ID', 'Model', 'IMEI', 'Price'],
    ['', 'M1', 'iPhone 11', '123456789012345', 300]
  ]));
  sheets.push(makeSheet('Summary', [['Metric', 'Value'], ['Total', 100]]));
  // The shared mock has no getFormulas (the Row ID backfill needs it). These fixtures have no formulas, so every cell reports none.
  sheets.forEach(sh => {
    const orig = sh.getRange;
    sh.getRange = (r, c, nr = 1, nc = 1) => {
      const rg = orig(r, c, nr, nc);
      rg.getFormulas = () => Array.from({ length: nr }, () => Array(nc).fill(''));
      return rg;
    };
  });
  return sheets;
};

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('Trades: adding a trade lands in the next free row with a generated Row ID; no other tab changes', () => {
  const sheets = makeTT();
  const trades = byName(sheets, 'Trades');
  const others = sheets.filter(s => s !== trades), before = snapAll(others);
  const ctx = load(sheets);
  const res = post(ctx, { id: 'x1', tab: 'Trades', values: { 'Asset Type': 'Crypto', Symbol: 'BTC', Direction: 'Long', Status: 'Open', Quantity: 0.5, 'Entry Price': 65000, Currency: 'USD' } });
  assert.equal(res.ok, true);
  assert.equal(res.row, 4);
  assert.deepEqual(res.unmatched, []);
  assert.ok(typeof res.rowId === 'string' && res.rowId.length > 0);
  assert.equal(trades.grid.length, 4);
  const row = trades.grid[3];
  assert.ok(isDate(row[0]));
  assert.equal(row[1], res.rowId);
  assert.equal(row[3], 'Crypto');
  assert.equal(row[4], 'BTC');
  assert.equal(row[7], 0.5);
  assert.equal(row[8], 65000);
  assert.deepEqual(ctx.__created, []);
  others.forEach((s, i) => assert.equal(snap(s), before[i]));
});

t('Pre-IPO: adding a bid lands in the next free row with a generated Row ID; no other tab changes', () => {
  const sheets = makeTT();
  const pre = byName(sheets, 'Pre-IPO');
  const others = sheets.filter(s => s !== pre), before = snapAll(others);
  const ctx = load(sheets);
  const res = post(ctx, { id: 'x2', tab: 'Pre-IPO', values: { Company: 'Acme', Ticker: 'ACM', Account: 'TFSA', Status: 'Bid placed', 'Shares Requested': 2, 'Price Low': 70, 'Price High': 78, Currency: 'USD' } });
  assert.equal(res.ok, true);
  assert.equal(res.row, 3);
  assert.deepEqual(res.unmatched, []);
  assert.ok(typeof res.rowId === 'string' && res.rowId.length > 0);
  assert.equal(pre.grid.length, 3);
  const row = pre.grid[2];
  assert.ok(isDate(row[0]));
  assert.equal(row[1], res.rowId);
  assert.equal(row[2], 'Acme');
  assert.equal(row[10], 2);
  assert.equal(row[12], 70);
  assert.equal(row[13], 78);
  assert.deepEqual(ctx.__created, []);
  others.forEach((s, i) => assert.equal(snap(s), before[i]));
});

t('Trades and Pre-IPO: retrying the same request id adds nothing', () => {
  const sheets = makeTT();
  const ctx = load(sheets);
  const trades = byName(sheets, 'Trades'), pre = byName(sheets, 'Pre-IPO');
  post(ctx, { id: 'dup-t', tab: 'Trades', values: { Symbol: 'SOL', Status: 'Open' } });
  post(ctx, { id: 'dup-p', tab: 'Pre-IPO', values: { Company: 'Beta Inc' } });
  const tLen = trades.grid.length, pLen = pre.grid.length;
  post(ctx, { id: 'dup-t', tab: 'Trades', values: { Symbol: 'SOL', Status: 'Open' } });
  post(ctx, { id: 'dup-p', tab: 'Pre-IPO', values: { Company: 'Beta Inc' } });
  assert.equal(trades.grid.length, tLen);
  assert.equal(pre.grid.length, pLen);
});

t('Trades: an edit by Row ID writes the cells and logs old and new values; the other trade is untouched', () => {
  const sheets = makeTT();
  const trades = byName(sheets, 'Trades');
  const t2Before = JSON.stringify(trades.grid[2]);
  const others = sheets.filter(s => s !== trades), beforeOthers = snapAll(others);
  const ctx = load(sheets);
  const res = post(ctx, { action: 'edit', target: 'Trades', rowId: 'T1', expect: { Symbol: 'AAPL', Quantity: 10 }, changes: { Status: 'Closed', 'Exit Price': 190 } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.updated.slice().sort(), ['Exit Price', 'Status']);
  assert.equal(trades.grid[1][6], 'Closed');
  assert.equal(trades.grid[1][9], 190);
  assert.equal(JSON.stringify(trades.grid[2]), t2Before);
  assert.deepEqual(ctx.__created, ['Edit Log']);
  const log = byName(sheets, 'Edit Log');
  assert.ok(log);
  assert.deepEqual(log.grid[0], LOG_HEAD);
  assert.equal(log.grid.length, 3);
  log.grid.slice(1).forEach(r => { assert.ok(isDate(r[0])); assert.equal(r[1], 'Trades'); assert.equal(r[2], 'T1'); assert.equal(r[6], 'edit'); });
  const st = log.grid.slice(1).find(r => r[3] === 'Status');
  assert.deepEqual([st[4], st[5]], ['Open', 'Closed']);
  others.forEach((s, i) => assert.equal(snap(s), beforeOthers[i]));
});

t('Pre-IPO: an edit by Row ID records the allocation and final price and logs it', () => {
  const sheets = makeTT();
  const pre = byName(sheets, 'Pre-IPO');
  const others = sheets.filter(s => s !== pre), beforeOthers = snapAll(others);
  const ctx = load(sheets);
  const res = post(ctx, { action: 'edit', target: 'Pre-IPO', rowId: 'P1', expect: { Company: 'Anthropic', 'Shares Requested': 2 }, changes: { Status: 'Allocated', 'Shares Allocated': 1, 'Final Price': 74 } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.updated.slice().sort(), ['Final Price', 'Shares Allocated', 'Status']);
  assert.equal(pre.grid[1][5], 'Allocated');
  assert.equal(pre.grid[1][11], 1);
  assert.equal(pre.grid[1][14], 74);
  assert.deepEqual(ctx.__created, ['Edit Log']);
  const log = byName(sheets, 'Edit Log');
  assert.equal(log.grid.length, 4);
  log.grid.slice(1).forEach(r => { assert.equal(r[1], 'Pre-IPO'); assert.equal(r[2], 'P1'); assert.equal(r[6], 'edit'); });
  others.forEach((s, i) => assert.equal(snap(s), beforeOthers[i]));
});

t('Trades and Pre-IPO: an edit whose expect no longer matches the live row is refused; nothing is written or logged', () => {
  const sheets = makeTT();
  const before = snapAll(sheets), count = sheets.length;
  const ctx = load(sheets);
  const a = post(ctx, { action: 'edit', target: 'Trades', rowId: 'T1', expect: { Symbol: 'AAPL', Quantity: 999 }, changes: { Status: 'Closed' } });
  const b = post(ctx, { action: 'edit', target: 'Pre-IPO', rowId: 'P1', expect: { Company: 'Someone Else', 'Shares Requested': 2 }, changes: { Status: 'Allocated' } });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.deepEqual(ctx.__created, []);
  assert.equal(sheets.length, count);
  unchanged(sheets, before);
});

t('Trades and Pre-IPO: delete is refused (tab not allowed); nothing changes', () => {
  const sheets = makeTT();
  const before = snapAll(sheets);
  const ctx = load(sheets);
  const a = post(ctx, { action: 'delete', target: 'Trades', rowId: 'T1', expect: { Symbol: 'AAPL', Quantity: 10 } });
  const b = post(ctx, { action: 'delete', target: 'Pre-IPO', rowId: 'P1', expect: { Company: 'Anthropic', 'Shares Requested': 2 } });
  [a, b].forEach(r => { assert.equal(r.ok, false); assert.ok(String(r.error).includes('tab not allowed')); });
  sheets.forEach(s => assert.deepEqual(s.deleted, []));
  unchanged(sheets, before);
});

t('Trades and Pre-IPO: reading returns the rows with row numbers; absent tabs come back as missing, are not created, and the other tabs still load', () => {
  const ctx1 = load(makeTT());
  const r1 = get(ctx1, { action: 'read' });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.tabs.Trades.rows.map(r => [r['Row ID'], r._row, r.Symbol]), [['T1', 2, 'AAPL'], ['T2', 3, 'ETH']]);
  assert.deepEqual(r1.tabs.PreIPO.rows.map(r => [r['Row ID'], r._row, r.Company]), [['P1', 2, 'Anthropic']]);
  assert.equal(r1.tabs.Trades.missing, undefined);
  assert.equal(r1.tabs.PreIPO.missing, undefined);
  assert.equal(get(ctx1, { action: 'check' }).ok, true);

  const sheets2 = makeTT({ noTrades: true, noPre: true });
  const before = snapAll(sheets2), count = sheets2.length;
  const ctx2 = load(sheets2);
  const r2 = get(ctx2, { action: 'read' });
  assert.equal(r2.ok, true);
  assert.equal(get(ctx2, { action: 'check' }).ok, true);
  assert.equal(r2.tabs.Trades.missing, true);
  assert.equal(r2.tabs.PreIPO.missing, true);
  assert.deepEqual(r2.tabs.Trades.rows, []);
  assert.deepEqual(r2.tabs.PreIPO.rows, []);
  assert.equal(r2.tabs.Expenses.rows.length, 1);
  assert.deepEqual(ctx2.__created, []);
  assert.equal(sheets2.length, count);
  unchanged(sheets2, before);
});

t('Trades and Pre-IPO: the Row ID backfill fills only the one empty Row ID on a row that has data, and nothing else', () => {
  const sheets = makeTT();
  const trades = byName(sheets, 'Trades'), pre = byName(sheets, 'Pre-IPO');
  trades.grid.push(['', '', '2026-11-03', 'Option', 'SPY', 'Long', 'Open', 1, 2.5, '', 0.65, 'USD', 100, 'Call', 600, '2026-11-21', '0DTE', '', 'backfill me']);
  const others = sheets.filter(s => s !== trades), beforeOthers = snapAll(others);
  const first3 = JSON.stringify(trades.grid.slice(0, 3));
  const rest = trades.grid[3].slice(2);
  const ctx = load(sheets);
  const res = post(ctx, { action: 'backfill' });
  assert.equal(res.ok, true);
  assert.equal(res.total, 1);
  assert.equal(JSON.stringify(trades.grid.slice(0, 3)), first3);
  assert.ok(typeof trades.grid[3][1] === 'string' && trades.grid[3][1].length > 0);
  assert.deepEqual(trades.grid[3].slice(2), rest);
  others.forEach((s, i) => assert.equal(snap(s), beforeOthers[i]));
  assert.equal(pre.grid.length, 2);
});

t('Trades and Pre-IPO: the tab lists allow add and edit only, never delete or trade; guests never see them', () => {
  const ctx = load(makeTT());
  const list = name => JSON.parse(vm.runInContext('JSON.stringify(' + name + ')', ctx));
  ['Trades', 'Pre-IPO'].forEach(tab => {
    assert.ok(list('ALLOWED_TABS').includes(tab));
    assert.ok(list('EDIT_ONLY_TABS').includes(tab));
    assert.ok(list('GUEST_HIDE_TABS').includes(tab));
    ['SALE_DELETE_TABS', 'TRADE_SOLD_TABS', 'TRADE_BOUGHT_TABS'].forEach(k => assert.ok(!list(k).includes(tab)));
  });
  assert.deepEqual(list('EDITABLE_TABS'), ['Expenses']);
  assert.equal(list('READ_TABS').Trades.tab, 'Trades');
  assert.equal(list('READ_TABS').PreIPO.tab, 'Pre-IPO');
});

console.log(`\n${n} checks passed`);

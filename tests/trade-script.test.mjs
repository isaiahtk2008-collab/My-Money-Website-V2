// Run with: node --test tests/trade-script.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and checks the doPost action `trade` (what the site sends for a Trade or Mixed sale):
// ONE request writes ONE Sold row and ONE received-device row, all or nothing, and the same id can never add a second pair.
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'apps-script.gs'), 'utf8');

function makeSheet(name, grid, formulas = {}, maxRows = grid.length) {
  const writes = [];
  const sheet = {
    name, grid, formulas, writes, maxRows,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max(0, ...grid.map(r => r.length)),
    getMaxRows: () => sheet.maxRows,
    insertRowsAfter: (after, n) => { for (let i = 0; i < n; i++) grid.push([]); sheet.maxRows += n; },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (grid[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
        getFormula: () => formulas[r + ',' + c] || '',
        getValue: () => { const v = (grid[r - 1] || [])[c - 1]; return v === undefined ? '' : v; },
        setValue: v => { writes.push([r, c, v]); while (grid.length < r) grid.push([]); grid[r - 1][c - 1] = v; }
      };
    }
  };
  return sheet;
}
function load(sheets, { secret = null } = {}) {
  const props = {}, cache = {};
  const ctx = {
    console,
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType(m) { this.mime = m; return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => sheets, getSpreadsheetTimeZone: () => 'UTC' }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString().slice(11, 19)) }
  };
  vm.createContext(ctx);
  vm.runInContext(secret == null ? code : code.replace(/const SECRET = '[^']*';/, `const SECRET = '${secret}';`), ctx);
  return ctx;
}
const parse = out => JSON.parse(out.text);
const post = (ctx, body) => parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }));
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';

function createFixture() {
  const sold = makeSheet('Form Responses - Sold', [
    ['Timestamp', 'Device Label', 'Sale Price', "Buyer's Name", 'Margin'],
    ['2026-10-01', 'Old phone', 300, 'Al', '=C2-100']
  ], { '2,5': '=C2-100' }, 6);
  const bought = makeSheet('Form Responses - PCs', [
    ['Timestamp', 'Serial Number', 'PC model', 'Purchase Price', 'Row ID'],
    ['2026-10-01', 'OLD1', 'Old PC', 100, 'rOLD']
  ], {}, 6);
  const expenses = makeSheet('Expenses', [['Timestamp', 'Item Purchased', 'Amount'], ['', 'Coffee', 4.5]]);
  const summary = makeSheet('Summary', [['Total'], [100]], { '2,1': '=SUM(1,2)' });
  return { sold, bought, expenses, summary, sheets: [sold, bought, expenses, summary] };
}

const REQ = {
  action: 'trade',
  id: 'T1',
  soldTab: 'Form Responses - Sold',
  soldValues: { 'Device Label': 'iPhone 12', 'Sale Price': 500, "Buyer's Name": 'Bo' },
  boughtTab: 'Form Responses - PCs',
  boughtValues: { 'Serial Number': 'SN123', 'PC model': 'ThinkPad', 'Purchase Price': 160 }
};

test('a trade writes one Sold row and one Bought row and nothing else', () => {
  const { sold, bought, expenses, summary, sheets } = createFixture();
  const res = post(load(sheets), REQ);
  assert.equal(res.ok, true);
  assert.equal(res.trade, true);
  assert.equal(res.id, 'T1');
  assert.equal(res.soldRow, 3);
  assert.equal(res.boughtRow, 3);
  assert.deepEqual(res.unmatchedSold, []);
  assert.deepEqual(res.unmatchedBought, []);
  assert.match(res.boughtRowId, /^r[0-9a-z]+$/);
  assert.equal(res.soldRowId, undefined);
  assert.equal(sold.grid[2][1], 'iPhone 12');
  assert.equal(sold.grid[2][2], 500);
  assert.equal(sold.grid[2][3], 'Bo');
  assert.equal(isDate(sold.grid[2][0]), true);
  assert.equal(bought.grid[2][1], 'SN123');
  assert.equal(bought.grid[2][2], 'ThinkPad');
  assert.equal(bought.grid[2][3], 160);
  assert.equal(isDate(bought.grid[2][0]), true);
  assert.equal(sold.writes.filter(([, c]) => c === 5).length, 0, 'the Margin formula column is never written');
  assert.equal(expenses.writes.length + summary.writes.length, 0);
  assert.equal(sold.grid[1][1], 'Old phone');
  assert.equal(bought.grid[1][1], 'OLD1');
});

test('the same id is idempotent: a retry adds nothing', () => {
  const { sold, bought, sheets } = createFixture();
  const ctx = load(sheets);
  assert.equal(post(ctx, REQ).trade, true);
  const sw = sold.writes.length, bw = bought.writes.length;
  assert.deepEqual(post(ctx, REQ), { ok: true, dup: true, status: 'success' });
  assert.deepEqual(post(ctx, REQ), { ok: true, dup: true, status: 'success' });
  assert.equal(sold.grid.length, 3);
  assert.equal(bought.grid.length, 3);
  assert.equal(sold.writes.length, sw);
  assert.equal(bought.writes.length, bw);
});

test('all or nothing: if the Bought row is blocked, the Sold tab is untouched and the id is not remembered', () => {
  const { sold, bought, sheets } = createFixture();
  bought.formulas['3,2'] = '=1';
  const ctx = load(sheets);
  const r1 = post(ctx, REQ);
  assert.equal(r1.ok, false);
  assert.equal(r1.which, 'bought');
  assert.equal(r1.error, 'target row not empty');
  assert.equal(sold.writes.length, 0);
  delete bought.formulas['3,2'];
  const r2 = post(ctx, REQ);
  assert.equal(r2.ok, true);
  assert.equal(r2.trade, true);
  assert.equal(sold.grid.length, 3);
  assert.equal(bought.grid.length, 3);
});

test('a missing tab refuses the whole trade', () => {
  const { sold, expenses } = createFixture();
  const res = post(load([sold, expenses]), REQ);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no tab: Form Responses - PCs');
  assert.equal(sold.writes.length, 0);
});

test('only a Sold tab and a Bought tab are accepted', () => {
  const { sold, bought, expenses, summary, sheets } = createFixture();
  const ctx = load(sheets);
  const a = post(ctx, { ...REQ, soldTab: 'Expenses' });
  assert.equal(a.ok, false); assert.ok(a.error.startsWith('tab not allowed: Expenses'));
  const b = post(ctx, { ...REQ, boughtTab: 'Summary' });
  assert.equal(b.ok, false); assert.ok(b.error.startsWith('tab not allowed: Summary'));
  const c = post(ctx, { ...REQ, soldTab: 'Form Responses - PCs', boughtTab: 'Form Responses - Sold' });
  assert.equal(c.ok, false); assert.ok(c.error.startsWith('tab not allowed'));
  assert.equal(sold.writes.length + bought.writes.length + expenses.writes.length + summary.writes.length, 0);
});

test('bad requests are refused without writing', () => {
  const { sold, bought, sheets } = createFixture();
  const ctx = load(sheets);
  const noId = { ...REQ }; delete noId.id;
  const cases = [
    [noId, 'trade needs an id'],
    [{ ...REQ, id: '' }, 'trade needs an id'],
    [{ ...REQ, soldValues: null }, 'trade needs soldValues and boughtValues'],
    [{ ...REQ, boughtValues: {} }, 'trade needs soldValues and boughtValues'],
    [{ ...REQ, boughtValues: ['x'] }, 'trade needs soldValues and boughtValues']
  ];
  for (const [payload, err] of cases) {
    const res = post(ctx, payload);
    assert.equal(res.ok, false);
    assert.equal(res.error, err);
  }
  assert.equal(sold.writes.length + bought.writes.length, 0);
});

test('if the second write fails, the first is undone and a retry works', () => {
  const { sold, bought, sheets } = createFixture();
  let broken = true;
  const orig = bought.getRange.bind(bought);
  bought.getRange = (...a) => {
    const rg = orig(...a); const sv = rg.setValue;
    rg.setValue = v => { if (broken) throw new Error('quota'); return sv(v); };
    return rg;
  };
  const ctx = load(sheets);
  const r1 = post(ctx, REQ);
  assert.equal(r1.ok, false);
  assert.equal(r1.rolledBack, true);
  assert.ok(r1.error.includes('nothing was kept'));
  for (let r = 2; r < sold.grid.length; r++) for (const cell of (sold.grid[r] || [])) assert.equal(cell === undefined || cell === '', true);
  assert.equal(sold.grid[1][1], 'Old phone');
  broken = false;
  const r2 = post(ctx, REQ);
  assert.equal(r2.ok, true);
  assert.equal(sold.grid[2][1], 'iPhone 12');
  assert.equal(bought.grid[2][1], 'SN123');
});

test('each row lands exactly where the plain add would put it', () => {
  const f1 = createFixture(); const ctx1 = load(f1.sheets);
  const rSold = post(ctx1, { id: 'A1', tab: 'Form Responses - Sold', values: REQ.soldValues });
  const rBought = post(ctx1, { id: 'A2', tab: 'Form Responses - PCs', values: REQ.boughtValues });
  const f2 = createFixture(); const ctx2 = load(f2.sheets);
  const rTrade = post(ctx2, REQ);
  assert.equal(rTrade.soldRow, rSold.row);
  assert.equal(rTrade.boughtRow, rBought.row);
  const a = f1.sold.grid[2], b = f2.sold.grid[2];
  assert.equal(a.length, b.length);
  a.forEach((v, c) => { if (c === 0) { assert.equal(isDate(v) && isDate(b[c]), true); } else assert.equal(v, b[c]); });
  const x = f1.bought.grid[2], y = f2.bought.grid[2];
  assert.equal(x.length, y.length);
  x.forEach((v, c) => {
    if (c === 0) assert.equal(isDate(v) && isDate(y[c]), true);
    else if (c === 4) { assert.match(v, /^r[0-9a-z]+$/); assert.match(y[c], /^r[0-9a-z]+$/); }
    else assert.equal(v, y[c]);
  });
});

test('the next free row is the one after the last used row, like the plain add', () => {
  const { sold, sheets } = createFixture();
  sold.grid[2] = []; sold.grid[3] = [];   /* real empty rows, not holes: a sparse array would make the mock's getLastColumn NaN */
  sold.grid[4] = ['2026-10-02', 'Gap phone', 200, 'Bob', '=C5-100'];
  sold.maxRows = 6;
  const res = post(load(sheets), REQ);
  assert.equal(res.ok, true);
  assert.equal(res.soldRow, 6);
  assert.equal(sold.grid[4][1], 'Gap phone');
  assert.equal(sold.grid[5][1], 'iPhone 12');
});

test('the secret is still required', () => {
  const { sold, bought, sheets } = createFixture();
  const ctx = load(sheets, { secret: 'abc' });
  const r1 = post(ctx, REQ);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'auth');
  assert.equal(sold.writes.length + bought.writes.length, 0);
  assert.equal(post(ctx, { ...REQ, secret: 'abc' }).trade, true);
});

test('the GET reply tells the site this script supports trades', () => {
  const { sheets } = createFixture();
  const res = parse(load(sheets).doGet({ parameter: {} }));
  assert.equal(res.ok, true);
  assert.equal(res.service, 'my-money-entry');
  assert.equal(res.read, true);
  assert.equal(res.edit, true);
  assert.equal(res.backfill, true);
  assert.equal(res.trade, true);
});

test('the plain add is unchanged, and an empty trade request writes nothing', () => {
  const { sold, bought, expenses, summary, sheets } = createFixture();
  const ctx = load(sheets);
  const add = post(ctx, { id: 'P1', tab: 'Expenses', values: { 'Item Purchased': 'Tea', Amount: 3 } });
  assert.equal(add.ok, true);
  assert.equal(add.row, 3);
  assert.equal(expenses.grid[2][1], 'Tea');
  assert.equal(expenses.grid[2][2], 3);
  assert.equal(post(ctx, { action: 'trade' }).ok, false);
  assert.equal(sold.writes.length + bought.writes.length + summary.writes.length, 0);
});

test('if the undo also fails, the id is remembered so a retry cannot add a second pair', () => {
  const { sold, bought, sheets } = createFixture();
  let boughtBroken = true;
  let soldUndoBroken = true;

  const origSold = sold.getRange.bind(sold);
  sold.getRange = (...args) => {
    const rg = origSold(...args);
    const origSv = rg.setValue.bind(rg);
    rg.setValue = (val) => {
      if (soldUndoBroken && val === '') throw new Error('undo failed');
      return origSv(val);
    };
    return rg;
  };

  const origBought = bought.getRange.bind(bought);
  bought.getRange = (...args) => {
    const rg = origBought(...args);
    const origSv = rg.setValue.bind(rg);
    rg.setValue = (val) => {
      if (boughtBroken) throw new Error('write failed');
      return origSv(val);
    };
    return rg;
  };

  const ctx = load(sheets);
  const r1 = post(ctx, REQ);
  assert.equal(r1.ok, false);
  assert.equal(r1.partial, true);
  assert.ok(r1.error.includes('Do not retry'));

  boughtBroken = false;
  soldUndoBroken = false;

  const r2 = post(ctx, REQ);
  assert.equal(r2.ok, true);
  assert.equal(r2.dup, true);

  assert.equal(bought.grid.some(r => r && (r[1] === 'SN123' || r[2] === 'SN123')), false);
  assert.equal(sold.grid.filter(r => r && (r[1] === 'iPhone 12' || r[2] === 'iPhone 12')).length, 1);
});

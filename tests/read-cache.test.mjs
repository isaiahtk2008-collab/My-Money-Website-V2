// Checks the speed changes in apps-script.gs: (1) plain reads are served from a short cache and need no lock on a hit,
// (2) anything that can change the sheet clears the cache, (3) a guest can never skip the cache or see unmasked data from it,
// (4) readTab reads far fewer cells on a tab with a long formula tail but returns exactly what the old function did.
// Google and the sheet are faked; no real data is involved.
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

const code = fs.readFileSync(new URL('../apps-script.gs', import.meta.url), 'utf8')
  .replace("'PASTE-YOUR-GOOGLE-CLIENT-ID.apps.googleusercontent.com'", "'client-1.apps.googleusercontent.com'")
  .replace("'you@example.com'", "'me@example.com'");

const TABS = () => ({
  Expenses: { sheet: 'Expenses', headers: ['Item Purchased', 'Amount', 'Notes'], rows: [{ 'Item Purchased': 'Rent', Amount: 900, Notes: 'private', _row: 2 }] },
  Phones: { sheet: 'Master Inventory', headers: ['Model', 'IMEI', 'Device Label', 'Notes'], rows: [{ Model: 'iPhone 13', IMEI: '123456789012345', 'Device Label': 'P-001', Notes: 'cracked', _row: 2 }] }
});

// opts.getAll: give the fake cache a getAll like the real one. opts.cacheThrows: CacheService itself fails.
function make(opts = {}) {
  const props = {}, store = {};
  const stats = { reads: 0, locks: 0, puts: 0 };
  const cache = {
    get: k => (k in store ? store[k] : null),
    put: (k, v) => { stats.puts++; store[k] = Buffer.from(String(v), 'utf8').toString('utf8'); }   // like the real cache: text is stored as UTF-8, so half an emoji would turn into a replacement character
  };
  if (opts.getAll) cache.getAll = keys => { const o = {}; keys.forEach(k => { if (k in store) o[k] = store[k]; }); return o; };
  const ctx = {
    console: { log() {} },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => { throw new Error('this test must not touch the sheet directly'); } },
    LockService: { getScriptLock: () => ({ waitLock() { stats.locks++; if (ctx.__lockFails) throw new Error('busy'); }, releaseLock() {} }) },
    CacheService: { getScriptCache: () => { if (opts.cacheThrows) throw new Error('cache down'); return cache; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    UrlFetchApp: { fetch: () => { throw new Error('no network'); } },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      formatDate: () => ''
    }
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  ctx.__stats = stats; ctx.__store = store;
  ctx.__data = TABS();
  ctx.readAll = () => { stats.reads++; return JSON.parse(JSON.stringify(ctx.__data)); };   // fake sheet read
  ctx.__owner = ctx.newSession_().token;
  return ctx;
}
const post = (c, b) => JSON.parse(c.doPost({ postData: { contents: JSON.stringify(b) } }).text);
const own = (c, b) => post(c, { ...b, secret: c.__owner });
const guestKey = (c, preset) => { const r = own(c, { action: 'guest_create', minutes: 60, preset }); assert.equal(r.ok, true); return r.key; };

test('a second read is served from the cache: no sheet read and no lock', () => {
  const c = make();
  const a = own(c, { action: 'read' });
  assert.equal(a.ok, true);
  assert.equal(c.__stats.reads, 1);
  const locksAfterFirst = c.__stats.locks;
  const b = own(c, { action: 'read' });
  assert.equal(c.__stats.reads, 1, 'the sheet was read again');
  assert.equal(c.__stats.locks, locksAfterFirst, 'a cache hit must not take the lock');
  assert.deepEqual(b.tabs, a.tabs);
});

test('the first read (a miss) still takes the lock, so it never sees a half-finished write', () => {
  const c = make();
  own(c, { action: 'read' });
  assert.ok(c.__stats.locks >= 1);
});

test('works the same with a cache that has getAll and one that does not', () => {
  for (const getAll of [false, true]) {
    const c = make({ getAll });
    const a = own(c, { action: 'read' });
    const b = own(c, { action: 'read' });
    assert.equal(c.__stats.reads, 1, 'getAll=' + getAll);
    assert.deepEqual(b.tabs, a.tabs);
  }
});

test('a large read is split into several cache entries and comes back identical', () => {
  const c = make({ getAll: true });
  c.__data = { Expenses: { sheet: 'Expenses', headers: ['Item Purchased'], rows: Array.from({ length: 1500 }, (_, i) => ({ 'Item Purchased': 'Item ' + i + ' é€ ' + 'x'.repeat(40), _row: i + 2 })) } };
  const a = own(c, { action: 'read' });
  const parts = Object.keys(c.__store).filter(k => /^mm\.rd\.[^.]+\.\d+$/.test(k) || /^mm\.rd\.[^.]+\.n$/.test(k));
  assert.ok(parts.length > 3, 'expected several chunks, got ' + parts.length);
  for (const k of parts) assert.ok(c.__store[k].length <= 30000, 'chunk too big: ' + k);
  const b = own(c, { action: 'read' });
  assert.equal(c.__stats.reads, 1);
  assert.deepEqual(b.tabs, a.tabs);
});

test('emoji and accents survive being split across cache entries, wherever the split falls', () => {
  for (const pad of [0, 1, 2, 3, 5, 7, 11]) {
    const c = make({ getAll: true });
    c.__data = { Expenses: { sheet: 'Expenses', headers: ['Item Purchased', 'Notes'], rows: Array.from({ length: 2600 }, (_, i) => ({ 'Item Purchased': 'x'.repeat(pad) + '😀 café €' + i + ' 日本', Notes: i % 7 ? '👍🏽 ok' : null, _row: i + 2 })) } };
    const a = own(c, { action: 'read' });
    assert.ok(Object.keys(c.__store).filter(k => /^mm\.rd\.[^.]+\.\d+$/.test(k)).length > 3, 'expected several chunks');
    const b = own(c, { action: 'read' });
    assert.equal(c.__stats.reads, 1, 'second read should come from the cache');
    assert.deepEqual(b.tabs, a.tabs, 'pad ' + pad);
    assert.ok(!JSON.stringify(b.tabs).includes('\ufffd'), 'a replacement character appeared');
  }
});

test('a read too big to cache is still returned, just never cached', () => {
  const c = make();
  c.__data = { Expenses: { sheet: 'Expenses', headers: ['A'], rows: Array.from({ length: 120 }, (_, i) => ({ A: 'y'.repeat(20000) + i, _row: i + 2 })) } };
  assert.equal(own(c, { action: 'read' }).ok, true);
  assert.equal(own(c, { action: 'read' }).ok, true);
  assert.equal(c.__stats.reads, 2);
});

test('anything that can change the sheet clears the cache first', () => {
  const c = make();
  own(c, { action: 'read' });
  assert.equal(c.__stats.reads, 1);
  c.__data.Expenses.rows[0].Amount = 1000;
  // guest_create is a write-type action that needs no sheet: it goes through the same "may change things" path as add/edit/delete/trade/undo/settings_set/backfill
  assert.equal(own(c, { action: 'guest_create', minutes: 60, preset: 'all' }).ok, true);
  const after = own(c, { action: 'read' });
  assert.equal(c.__stats.reads, 2, 'the cache was not cleared by the write');
  assert.equal(after.tabs.Expenses.rows[0].Amount, 1000);
});

test('a refused write still clears the cache (a half-done write must never be served old)', () => {
  const c = make();
  own(c, { action: 'read' });
  own(c, { action: 'edit' });   // refused (no sheet in this fake), but it was a write-type action
  own(c, { action: 'read' });
  assert.equal(c.__stats.reads, 2);
});

test('check and settings_get are not writes and do not clear the cache', () => {
  const c = make();
  c.checkAll = () => ({});
  c.readSettings_ = () => ({});
  c.SpreadsheetApp.getActiveSpreadsheet = () => ({});
  own(c, { action: 'read' });
  own(c, { action: 'check' });
  own(c, { action: 'settings_get' });
  own(c, { action: 'read' });
  assert.equal(c.__stats.reads, 1);
});

test('the owner can ask for a fresh read, which skips the cache and replaces it for everyone', () => {
  const c = make();
  own(c, { action: 'read' });
  c.__data.Expenses.rows[0].Amount = 5;
  const f = own(c, { action: 'read', fresh: true });
  assert.equal(c.__stats.reads, 2);
  assert.equal(f.tabs.Expenses.rows[0].Amount, 5);
  const next = own(c, { action: 'read' });
  assert.equal(c.__stats.reads, 2, 'the fresh read should have refilled the cache');
  assert.equal(next.tabs.Expenses.rows[0].Amount, 5);
});

test('a guest can never skip the cache, even by sending fresh', () => {
  const c = make();
  const key = guestKey(c, 'all');
  own(c, { action: 'read' });
  const reads = c.__stats.reads;
  for (const fresh of [true, 1, '1']) assert.equal(post(c, { action: 'read', secret: key, fresh }).ok, true);
  assert.equal(c.__stats.reads, reads, 'a guest forced a sheet read');
});

test('guest links are masked from the cached data, and masking never leaks back into the owner view', () => {
  const c = make();
  const key = guestKey(c, 'sales');
  const owner1 = own(c, { action: 'read' });          // fills the cache with the full data
  const guest = post(c, { action: 'read', secret: key });
  assert.equal(guest.tabs.Phones.rows[0].IMEI, '(hidden)');
  assert.equal(guest.tabs.Phones.rows[0].Notes, '(hidden)');
  assert.deepEqual(guest.tabs.Expenses.rows, []);   // the sales preset hides expenses entirely
  const owner2 = own(c, { action: 'read' });
  assert.equal(owner2.tabs.Phones.rows[0].IMEI, '123456789012345');
  assert.deepEqual(owner2.tabs, owner1.tabs);
});

test('requests with no valid token are refused without taking the lock or reading the sheet', () => {
  const c = make();
  for (const secret of [undefined, '', 'nope', 'x'.repeat(64), 5, {}]) {
    const r = post(c, { action: 'read', secret });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'auth');
  }
  assert.equal(c.__stats.locks, 0);
  assert.equal(c.__stats.reads, 0);
});

test('bad JSON is refused without taking the lock', () => {
  const c = make();
  const r = JSON.parse(c.doPost({ postData: { contents: '{not json' } }).text);
  assert.equal(r.ok, false);
  assert.equal(c.__stats.locks, 0);
});

test('if the cache is broken, reads still work (just slower)', () => {
  const c = make({ cacheThrows: true });
  assert.equal(own(c, { action: 'read' }).ok, true);
  assert.equal(own(c, { action: 'read' }).ok, true);
  assert.equal(c.__stats.reads, 2);
});

test('a half-stored read (count missing) is never used', () => {
  const c = make();
  own(c, { action: 'read' });
  const gen = c.__store['mm.rd.gen'];
  delete c.__store['mm.rd.' + gen + '.n'];
  own(c, { action: 'read' });
  assert.equal(c.__stats.reads, 2);
});

test('a corrupted cache entry is ignored and the sheet is read instead', () => {
  const c = make();
  own(c, { action: 'read' });
  const gen = c.__store['mm.rd.gen'];
  c.__store['mm.rd.' + gen + '.0'] = '{"broken';
  const r = own(c, { action: 'read' });
  assert.equal(r.ok, true);
  assert.equal(c.__stats.reads, 2);
});

test('if the lock cannot be had on a cache miss, the read fails cleanly instead of crashing', () => {
  const c = make();
  c.__lockFails = true;
  const r = own(c, { action: 'read' });
  assert.equal(r.ok, false);
  assert.match(r.error, /busy/);
});

test('every non-read action still takes the lock before it does anything (old behaviour kept)', () => {
  const c = make();
  for (const action of ['guest_list', 'guest_create', 'guest_revoke', 'edit', 'delete', 'undo', 'settings_set', 'backfill', 'trade', 'logout']) {
    const before = c.__stats.locks;
    try { own(c, { action, minutes: 60, preset: 'all', all: true }); } catch (e) { /* the fake sheet may throw; only the lock matters here */ }
    assert.ok(c.__stats.locks > before, action + ' did not take the lock');
  }
});

test('the row-id trigger functions clear the cache too', () => {
  const c = make();
  c.SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheets: () => [] });
  own(c, { action: 'read' });
  c.backfillRowIds();
  own(c, { action: 'read' });
  assert.equal(c.__stats.reads, 2);
});

/* ---------------- readTab: same rows as the old function, far fewer cells read ---------------- */

// The old readTab, frozen here exactly as it was before this change, so the new one can be compared with it.
const OLD_READTAB = `
function oldReadTab(ss, spec, tz) {
  const sheet = findSheet(ss, spec.tab);
  if (!sheet) return { sheet: spec.tab, headers: [], rows: [], missing: true };
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { sheet: spec.tab, headers: [], rows: [] };
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(h => String(h).replace(/\\u00a0/g, ' ').trim());
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = cleanCell(values[r][i], tz); });
    if (o._row === undefined) o._row = r + 1;
    rows.push(o);
  }
  let keys = spec.keys.filter(k => headers.indexOf(k) >= 0);
  if (!keys.length) keys = headers.filter(Boolean);
  const real = row => keys.some(k => row[k] !== null && row[k] !== undefined);
  while (rows.length && !real(rows[rows.length - 1])) rows.pop();
  return { sheet: spec.tab, headers, rows };
}`;

function fakeSheet(name, grid, counter) {
  const lastRow = () => { let n = 0; grid.forEach((row, i) => { if (row.some(v => v !== '')) n = i + 1; }); return n; };
  return {
    getName: () => name,
    getLastRow: lastRow,
    getLastColumn: () => Math.max(0, ...grid.map(r => { let n = 0; r.forEach((v, i) => { if (v !== '') n = i + 1; }); return n; })),
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        counter.cells += nr * nc;
        return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const row = grid[r - 1 + i]; return row && row[c - 1 + j] !== undefined ? row[c - 1 + j] : ''; }));
      }
    })
  };
}
function readTabBoth(grid, spec) {
  const c = make();
  vm.runInContext(OLD_READTAB, c);
  const counters = { old: { cells: 0 }, now: { cells: 0 } };
  const ssFor = counter => ({ getSheets: () => [fakeSheet(spec.tab, grid, counter)] });
  const tz = 'America/Toronto';
  c.__oldSS = ssFor(counters.old); c.__newSS = ssFor(counters.now); c.__spec = spec; c.__tz = tz;
  const oldR = vm.runInContext('oldReadTab(__oldSS, __spec, __tz)', c);
  const newR = vm.runInContext('readTab(__newSS, __spec, __tz)', c);
  return { oldR: JSON.parse(JSON.stringify(oldR)), newR: JSON.parse(JSON.stringify(newR)), counters };
}

const HEAD = ['PC model', 'Device Label', 'Status', 'Profit '];   // the last header has a non-breaking space, like real sheet headers can
const SPEC = { tab: 'PCs', keys: ['PC model', 'Device Label'] };
// a formula tail: key columns look empty, but other columns hold formula results (0, text, an error) all the way down
const tail = n => Array.from({ length: n }, () => ['', '', 'In stock', 0]);

test('readTab: formula tail below the real data gives the same rows with far fewer cells read', () => {
  // Shaped like the real PCs tab: 32 columns, a few real rows, then a long formula tail (key columns look empty, other columns hold formula results).
  const filler = Array.from({ length: 28 }, (_, i) => 'Col ' + i);
  const head32 = [...HEAD, ...filler];
  const real = (a, b, status, profit) => [a, b, status, profit, ...filler.map(() => 0)];
  const tail32 = Array.from({ length: 3000 }, () => ['', '', 'In stock', 0, ...filler.map(() => 0)]);
  const grid = [head32, real('Dell', 'C-001', 'Sold', 50), real('HP', 'C-002', 'In stock', 0), ...tail32];
  const { oldR, newR, counters } = readTabBoth(grid, SPEC);
  assert.deepEqual(newR, oldR);
  assert.equal(newR.rows.length, 2);
  assert.ok(counters.now.cells < counters.old.cells / 10, `read ${counters.now.cells} cells vs ${counters.old.cells}`);
});

test('readTab: blank rows in the middle are kept, only the tail is dropped', () => {
  const grid = [HEAD, ['Dell', 'C-001', 'Sold', 50], ['', '', 'In stock', 0], ['', '', '', ''], ['HP', 'C-004', 'In stock', 0], ...tail(500)];
  const { oldR, newR } = readTabBoth(grid, SPEC);
  assert.deepEqual(newR, oldR);
  assert.equal(newR.rows.length, 4);
  assert.equal(newR.rows[3]._row, 5);
});

test('readTab: no real rows at all gives no rows, like before', () => {
  const grid = [HEAD, ...tail(200)];
  const { oldR, newR } = readTabBoth(grid, SPEC);
  assert.deepEqual(newR, oldR);
  assert.deepEqual(newR.rows, []);
});

test('readTab: values that clean to empty (N/A, dash, #REF!) do not count as data in a key column', () => {
  const grid = [HEAD, ['Dell', 'C-001', 'Sold', 50], ['N/A', '-', 'In stock', 0], ['#REF!', '', 'In stock', 0], ...tail(50)];
  const { oldR, newR } = readTabBoth(grid, SPEC);
  assert.deepEqual(newR, oldR);
  assert.equal(newR.rows.length, 1);
});

test('readTab: data only in the second key column still counts', () => {
  const grid = [HEAD, ['Dell', '', 'Sold', 50], ['', 'C-009', 'In stock', 0], ...tail(50)];
  const { oldR, newR } = readTabBoth(grid, SPEC);
  assert.deepEqual(newR, oldR);
  assert.equal(newR.rows.length, 2);
});

test('readTab: key columns not in the headers fall back to the old full read', () => {
  const grid = [['Foo', 'Bar'], ['a', 'b'], ['c', ''], ['', '']];
  const { oldR, newR } = readTabBoth(grid, { tab: 'PCs', keys: ['Nope'] });
  assert.deepEqual(newR, oldR);
});

test('readTab: tabs that list no key columns (entry tabs) are read exactly as before', () => {
  const grid = [['Timestamp', 'Serial Number'], ['2026-01-02', 'S1'], ['2026-01-03', 'S2']];
  const { oldR, newR, counters } = readTabBoth(grid, { tab: 'PCs', keys: [] });
  assert.deepEqual(newR, oldR);
  assert.equal(counters.now.cells, counters.old.cells);
});

test('readTab: a repeated key header uses the last matching column, like the row object does', () => {
  const grid = [['PC model', 'Device Label', 'PC model'], ['', 'L1', ''], ['', 'L2', 'Dell'], ['', '', ''], ['', '', '']];
  const { oldR, newR } = readTabBoth(grid, SPEC);
  assert.deepEqual(newR, oldR);
});

test('readTab: a missing tab and an empty tab keep their old answers', () => {
  const c = make();
  vm.runInContext(OLD_READTAB, c);
  c.__ss = { getSheets: () => [] };
  c.__spec = SPEC;
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('readTab(__ss, __spec, "x")', c))), { sheet: 'PCs', headers: [], rows: [], missing: true });
  const counter = { cells: 0 };
  c.__ss2 = { getSheets: () => [fakeSheet('PCs', [], counter)] };
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('readTab(__ss2, __spec, "x")', c))), { sheet: 'PCs', headers: [], rows: [] });
});

// Run with: node --test tests/settings-sync.test.mjs
// Settings sync across devices (themes, appearance, saved login record).
// Part 1 runs the REAL apps-script.gs against a fake spreadsheet: only the new "MM Settings" tab is ever created or written, the newest
//   change wins, only allowed keys are kept, the login record needs a SECRET, values can never become formulas, bad input is refused.
// Part 2 runs the REAL browser module from index.html on two fake devices wired to that script: changes travel both ways, nothing
//   per-device (link, secret, lockout counters) is ever sent, no echo loops, failures keep changes queued, reloads are guarded.
// Never touches a real sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { authWrap } from './helpers/gs-auth.mjs';
const gs = fs.readFileSync(new URL('../apps-script.gs', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const modMatch = html.match(/<script id="mm-settings-sync">([\s\S]*?)<\/script>/);
const hfxMatch = html.match(/<script id="mm-hover-fx-js">([\s\S]*?)<\/script>/);

const URL_EXEC = 'https://script.google.com/macros/s/TEST/exec';
const CRED = JSON.stringify({ u: 'isaiah', s: 'c2FsdHNhbHQ=', h: 'aGFzaGhhc2g=', i: 150000 });

/* ---------------- fake spreadsheet ---------------- */
function makeSheetFake(name, rows = []) {
  const grid = rows.map(r => r.slice());
  const s = {
    name, grid, frozen: 0, formats: [],
    getName: () => name,
    getLastRow: () => grid.length,
    setFrozenRows: n => { s.frozen = n; },
    getRange(r, c, nr = 1, nc = 1) {
      if (typeof r === 'string') return { setNumberFormat: f => { s.formats.push([r, f]); } };
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (grid[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
        setValues: vals => { vals.forEach((row, i) => row.forEach((v, j) => { while (grid.length < r + i) grid.push([]); grid[r - 1 + i][c - 1 + j] = v; })); }
      };
    }
  };
  return s;
}
// A tab that must never be touched: every method except getName is recorded.
function makeGuardSheet(name) {
  const calls = [];
  const sheet = new Proxy({}, { get: (_, p) => (p === 'getName' ? () => name : p === 'calls' ? calls : (...a) => { calls.push(String(p)); }) });
  return sheet;
}

function makeScript({ secret = '', sheets = [] } = {}) {
  const created = [];
  const ss = {
    getSheets: () => sheets,
    getSheetByName: n => sheets.find(s => s.getName() === n) || null,
    getNumSheets: () => sheets.length,
    insertSheet: (n, idx) => { const s = makeSheetFake(n); sheets.splice(idx === undefined ? sheets.length : idx, 0, s); created.push(n); return s; },
    getSpreadsheetTimeZone: () => 'UTC'
  };
  const ctx = {
    console,
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType(m) { this.mime = m; return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString().slice(11, 19)) }
  };
  let src = gs;
  if (secret) {
    src = gs.replace("const SECRET = '';", 'const SECRET = ' + JSON.stringify(secret) + ';');
    assert.notEqual(src, gs, 'could not set SECRET for the test');
  }
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  authWrap(ctx);
  ctx.__sheets = sheets; ctx.__created = created;
  return ctx;
}
const parse = out => { assert.equal(out.mime, 'JSON'); return JSON.parse(out.text); };
const post = (c, body) => parse(c.doPost({ postData: { contents: JSON.stringify(body) } }));
const get = (c, parameter) => parse(c.doGet({ parameter }));
const T0 = Date.now() - 1000000;
const settingsTab = c => c.__sheets.find(s => s.getName() === 'MM Settings');

/* ---------------- Part 1: the script ---------------- */
test('reading settings on a sheet without the tab returns nothing and creates no tab', () => {
  const exp = makeGuardSheet('Expenses');
  const c = makeScript({ sheets: [exp] });
  const r = get(c, { action: 'settings' });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: true, version: 3, secretSet: false, settings: {}, status: 'success' });
  assert.deepEqual(c.__created, []);
  assert.deepEqual([...exp.calls], []);
});

test('the service info says settings are supported, and whether a secret is set', () => {
  assert.equal(get(makeScript(), {}).settings, true);
  assert.equal(get(makeScript(), {}).settingsSecret, false);
  assert.equal(get(makeScript({ secret: 'abc' }), {}).settingsSecret, true);
  assert.equal(get(makeScript(), {}).edit, true, 'existing flags must stay');
});

test('saving creates only the MM Settings tab, with headers, plain-text values, and leaves every other tab untouched', () => {
  const exp = makeGuardSheet('Expenses'), sold = makeGuardSheet('Form Responses - Sold');
  const c = makeScript({ sheets: [exp, sold] });
  const r = post(c, { action: 'settings_set', items: [{ k: 'mm.theme', v: 'dark', t: T0 }, { k: 'mm.hfx.s', v: '70', t: T0 + 1 }] });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.applied], ['mm.theme', 'mm.hfx.s']);
  assert.deepEqual(c.__created, ['MM Settings']);
  const tab = settingsTab(c);
  assert.deepEqual(tab.grid[0], ['Key', 'Value (JSON)', 'UpdatedAt (ms)', 'UpdatedAt (ISO)']);
  assert.equal(tab.grid[1][1], '"dark"');
  assert.equal(tab.grid.length, 3);
  assert.ok(tab.formats.some(f => f[0] === 'B:B' && f[1] === '@'), 'value column must be plain text');
  assert.equal(tab.frozen, 1);
  assert.deepEqual([...exp.calls], []);
  assert.deepEqual([...sold.calls], []);
  assert.equal(c.__sheets[c.__sheets.length - 1].getName(), 'MM Settings', 'new tab goes at the end');
  assert.deepEqual(JSON.parse(JSON.stringify(get(c, { action: 'settings' }).settings)), { 'mm.theme': { v: 'dark', t: T0 }, 'mm.hfx.s': { v: '70', t: T0 + 1 } });
});

test('newest change wins: older and equal times are refused, newer applies, removal is stored and read back as null', () => {
  const c = makeScript();
  post(c, { action: 'settings_set', items: [{ k: 'mm.theme', v: 'dark', t: T0 }] });
  const older = post(c, { action: 'settings_set', items: [{ k: 'mm.theme', v: 'light', t: T0 - 5 }, { k: 'mm.theme', v: 'light', t: T0 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(older.skipped)), [{ k: 'mm.theme', reason: 'older' }, { k: 'mm.theme', reason: 'older' }]);
  assert.equal(older.settings['mm.theme'].v, 'dark');
  const newer = post(c, { action: 'settings_set', items: [{ k: 'mm.theme', v: 'light', t: T0 + 1 }] });
  assert.deepEqual([...newer.applied], ['mm.theme']);
  post(c, { action: 'settings_set', items: [{ k: 'mm.theme', v: null, t: T0 + 2 }] });
  assert.equal(settingsTab(c).grid[1][1], 'null');
  assert.equal(get(c, { action: 'settings' }).settings['mm.theme'].v, null);
  assert.equal(settingsTab(c).grid.length, 2, 'same key reuses its row');
});

test('two changes to one setting in one request keep only the newest, in one row', () => {
  const c = makeScript();
  post(c, { action: 'settings_set', items: [{ k: 'mm.ss.prefs', v: 'a', t: T0 }, { k: 'mm.ss.prefs', v: 'b', t: T0 + 5 }] });
  assert.equal(settingsTab(c).grid.length, 2);
  assert.equal(get(c, { action: 'settings' }).settings['mm.ss.prefs'].v, 'b');
  const c2 = makeScript();
  const r = post(c2, { action: 'settings_set', items: [{ k: 'mm.ss.prefs', v: 'b', t: T0 + 5 }, { k: 'mm.ss.prefs', v: 'a', t: T0 }] });
  assert.equal(r.settings['mm.ss.prefs'].v, 'b');
  assert.equal(r.skipped.length, 1);
});

test('only the agreed settings are kept: per-device keys and unknown keys are refused', () => {
  const c = makeScript();
  const r = post(c, { action: 'settings_set', items: [
    { k: 'mm.lgUrl', v: 'https://x', t: T0 }, { k: 'mm.lgSecret', v: 's', t: T0 }, { k: 'mm.sheetId', v: 'id', t: T0 },
    { k: 'mm.auth.f', v: '3', t: T0 }, { k: 'evil', v: 'x', t: T0 }, { k: 5, v: 'x', t: T0 }, null, { k: 'mm.theme', v: 'dark', t: T0 }
  ] });
  assert.deepEqual([...r.applied], ['mm.theme']);
  assert.equal(r.skipped.length, 7);
  assert.ok(r.skipped.every(s => s.reason === 'key not allowed'));
  assert.equal(settingsTab(c).grid.length, 2);
});

test('the login record is refused and never returned without a SECRET, and works with one', () => {
  const c = makeScript();
  const r = post(c, { action: 'settings_set', items: [{ k: 'mm.auth.cred', v: CRED, t: T0 }] });
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped[0].reason, 'secret required');
  const c2 = makeScript({ secret: 'abc' });
  const r2 = post(c2, { secret: 'abc', action: 'settings_set', items: [{ k: 'mm.auth.cred', v: CRED, t: T0 }] });
  assert.deepEqual([...r2.applied], ['mm.auth.cred']);
  assert.equal(get(c2, { action: 'settings', secret: 'abc' }).settings['mm.auth.cred'].v, CRED);
  // a copy of the sheet opened by a script with no secret must not hand the record out
  const sheets = c2.__sheets;
  const c3 = makeScript({ sheets });
  assert.equal(get(c3, { action: 'settings' }).settings['mm.auth.cred'], undefined);
});

test('a wrong or missing secret is refused for reading and saving, and nothing is created', () => {
  const c = makeScript({ secret: 'abc' });
  const rawPost = b => parse(c.__rawPost({ postData: { contents: JSON.stringify(b) } }));
  assert.equal(rawPost({ action: 'settings_get' }).error, 'auth');
  assert.equal(rawPost({ action: 'settings_get', secret: '' }).error, 'auth');
  assert.equal(get(c, { action: 'settings', secret: 'nope' }).error, 'auth');
  assert.equal(post(c, { secret: 'nope', action: 'settings_set', items: [{ k: 'mm.theme', v: 'dark', t: T0 }] }).error, 'auth');
  assert.deepEqual(c.__created, []);
});

test('values that look like formulas stay plain text, and bad input is refused', () => {
  const c = makeScript();
  const evil = '=HYPERLINK("http://x","y")';
  const big = 'x'.repeat(2001);
  const r = post(c, { action: 'settings_set', items: [
    { k: 'mm.theme', v: evil, t: T0 },
    { k: 'mm.dense', v: 5, t: T0 }, { k: 'mm.ss.prefs', v: big, t: T0 }, { k: 'mm.privacy', v: '1', t: Date.now() + 11 * 60 * 1000 },
    { k: 'mm.nav.order', v: 'x', t: 1.5 }, { k: 'mm.ss.prefs', v: 'x', t: 0 }, { k: 'mm.notif', v: 'x', t: '9' }
  ] });
  assert.deepEqual([...r.applied], ['mm.theme']);
  assert.equal(settingsTab(c).grid[1][1], JSON.stringify(evil));
  assert.ok(settingsTab(c).grid[1][1].startsWith('"'), 'must not start with =');
  assert.deepEqual(r.skipped.map(s => s.reason), ['bad value', 'too long', 'time in future', 'bad time', 'bad time', 'bad time']);
  assert.equal(r.settings['mm.theme'].v, evil);
});

test('at most 40 items are processed per request', () => {
  const c = makeScript();
  const items = Array.from({ length: 45 }, (_, i) => ({ k: 'mm.theme', v: 'v' + i, t: T0 + i }));
  const r = post(c, { action: 'settings_set', items });
  assert.equal(r.settings['mm.theme'].t, T0 + 39);
});

test('a different tab already named MM Settings is never written to', () => {
  const other = makeSheetFake('MM Settings', [['Name', 'Amount'], ['rent', 1500]]);
  const before = JSON.stringify(other.grid);
  const c = makeScript({ sheets: [other] });
  const r = post(c, { action: 'settings_set', items: [{ k: 'mm.theme', v: 'dark', t: T0 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: false, error: 'settings tab conflict', status: 'error' });
  assert.equal(JSON.stringify(other.grid), before);
  assert.deepEqual(get(c, { action: 'settings' }).settings, {});
});

test('damaged rows are skipped when reading, good rows still come back', () => {
  const tab = makeSheetFake('MM Settings', [
    ['Key', 'Value (JSON)', 'UpdatedAt (ms)', 'UpdatedAt (ISO)'],
    ['mm.theme', '{broken', T0, ''], ['mm.ss.prefs', '"90d"', 'abc', ''], ['mm.dense', '42', T0, ''], ['mm.privacy', '"1"', T0, ''], ['mm.lgUrl', '"x"', T0, '']
  ]);
  const c = makeScript({ sheets: [tab] });
  assert.deepEqual(JSON.parse(JSON.stringify(get(c, { action: 'settings' }).settings)), { 'mm.privacy': { v: '1', t: T0 } });
});

test('existing actions still behave the same (unknown tab refused, nothing created)', () => {
  const c = makeScript({ sheets: [makeGuardSheet('Expenses')] });
  const r = post(c, { tab: 'Nope', values: { a: 1 }, id: 'x1' });
  assert.equal(r.ok, false);
  assert.deepEqual(c.__created, []);
});

/* ---------------- Part 2: the browser module on fake devices ---------------- */
function makeNet(script) {
  const log = [];
  const net = {
    log, down: false, infoOverride: null,
    fetch: async (url, init = {}) => {
      log.push({ url, method: init.method || 'GET', body: init.body });
      if (net.down) throw new Error('network down');
      let out;
      if ((init.method || 'GET') === 'POST') {
        let body = init.body;
        try { const b = JSON.parse(body); if (b && b.secret === 'sec') { b.secret = script.__token; body = JSON.stringify(b); } } catch (e) {}
        out = script.doPost({ postData: { contents: body } });
      }
      else {
        const u = new URL(url);
        const parameter = Object.fromEntries(u.searchParams);
        out = script.doGet({ parameter });
        if (net.infoOverride && !parameter.action) out = { text: JSON.stringify(net.infoOverride), mime: 'JSON' };
      }
      return { json: async () => JSON.parse(out.text) };
    }
  };
  return net;
}

function makeDevice(net, { url = URL_EXEC, secret = '', pre = {} } = {}) {
  class Storage {
    constructor() { this.m = new Map(); this.fail = new Set(); }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
    setItem(k, v) { if (this.fail.has(k)) throw new Error('quota'); this.m.set(k, String(v)); }
    removeItem(k) { this.m.delete(k); }
  }
  const ls = new Storage(), ss = new Storage();
  const calls = { reload: 0, render: 0, applyTheme: 0, hfx: 0, toasts: [], privacy: null, events: 0 };
  const timers = [];
  let nextId = 1, offset = 0;
  const doc = {
    readyState: 'complete', hidden: false, activeElement: null, listeners: {},
    body: { classList: { toggle: (c, on) => { calls.privacy = on; } } },
    addEventListener(ev, fn) { (doc.listeners[ev] = doc.listeners[ev] || []).push(fn); },
    getElementById: () => doc.overlay || null, querySelector: () => null
  };
  const win = {
    fetch: net.fetch, Storage, localStorage: ls, sessionStorage: ss, document: doc, location: { reload() { calls.reload++; } },
    setTimeout: (fn, ms) => { const t = { id: nextId++, fn, ms, on: true }; timers.push(t); return t.id; },
    clearTimeout: id => { const t = timers.find(x => x.id === id); if (t) t.on = false; },
    setInterval: (fn, ms) => { const t = { id: nextId++, fn, ms, on: true, every: true }; timers.push(t); return t.id; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Date: { now: () => Date.now() + offset },
    S: { theme: 'auto', privacy: false },
    applyTheme: () => { calls.applyTheme++; }, render: () => { calls.render++; }, toast: m => { calls.toasts.push(m); },
    console, JSON, Promise, Array, Object, String, Math, parseInt, isFinite, encodeURIComponent, Error, Map
  };
  win.window = win;
  win.addEventListener = () => {};
  win.dispatchEvent = () => { calls.events++; return true; };
  win.__mmHfxReload = () => { calls.hfx++; };
  ls.setItem('mm.lgUrl', url);
  if (secret) ls.setItem('mm.lgSecret', secret);
  Object.entries(pre).forEach(([k, v]) => ls.setItem(k, v));
  vm.createContext(win);
  vm.runInContext(modMatch[1], win);
  const api = win.__mmSettingsSync;
  timers.length = 0; // the startup and interval timers are driven by hand in these tests
  return {
    ls, ss, calls, timers, doc, win, api,
    sync: () => api.syncNow(),
    set: (k, v) => ls.setItem(k, v), get: k => ls.getItem(k),
    later: ms => { offset += ms; },
    metaOf: () => JSON.parse(ls.getItem('mm.sync.m') || '{}'),
    fireTimeout: ms => { const due = timers.filter(t => t.on && !t.every && t.ms === ms); due.forEach(t => { t.on = false; t.fn(); }); return due.length; }
  };
}
const sent = net => net.log.filter(l => l.method === 'POST').map(l => JSON.parse(l.body)).filter(b => b.action === 'settings_set');
const sentKeys = net => sent(net).flatMap(b => b.items.map(i => i.k));

test('the module is in the page once, before the login script, and its key list matches the script exactly', () => {
  assert.equal((html.match(/id="mm-settings-sync"/g) || []).length, 1);
  assert.ok(html.indexOf('id="mm-settings-sync"') < html.indexOf('Authentication: Google OAuth 2.0'), 'must load before the login script');
  const c = makeScript();
  const scriptKeys = vm.runInContext('SETTINGS_ALLOWED', c);
  const dev = makeDevice(makeNet(c));
  assert.deepEqual([...dev.api.keys].sort(), [...scriptKeys].sort());
  for (const bad of ['mm.range', 'mm.ap.drawer', 'mm.lgUrl', 'mm.lgSecret', 'mm.sheetId', 'mm.auth.f', 'mm.auth.u', 'mm.auth.method', 'mm.unlocked', 'mm.sync.m']) assert.ok(!dev.api.keys.includes(bad), bad + ' must never sync');
});

test('a theme change on one device shows up on the other, live, without a reload', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net), B = makeDevice(net);
  A.set('mm.theme', 'dark');
  const ra = await A.sync();
  assert.equal(ra.ok, true);
  assert.deepEqual([...ra.pushed], ['mm.theme']);
  const rb = await B.sync();
  assert.deepEqual([...rb.pulled], ['mm.theme']);
  assert.equal(B.get('mm.theme'), 'dark');
  assert.equal(B.win.S.theme, 'dark');
  assert.equal(B.calls.applyTheme, 1);
  assert.equal(B.calls.render, 1);
  assert.equal(B.calls.reload, 0);
  assert.ok(B.calls.events > 0, 'status event fires');
});

test('if you are typing when a theme change lands, the page redraws once you stop (not before)', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net), B = makeDevice(net);
  A.set('mm.theme', 'dark'); await A.sync();
  B.doc.activeElement = { tagName: 'INPUT' };
  await B.sync();
  assert.equal(B.win.S.theme, 'dark', 'the theme itself changes straight away');
  assert.equal(B.calls.render, 0, 'but the page is not redrawn under your typing');
  B.doc.activeElement = null;
  assert.equal(B.fireTimeout(3000), 1);
  assert.equal(B.calls.render, 1);
});

test('privacy and Appearance changes apply live; removing a setting removes it on the other device', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net), B = makeDevice(net);
  A.set('mm.privacy', '1'); A.set('mm.hfx.s', '80'); A.set('mm.hfx.acc', 'green');
  await A.sync(); await B.sync();
  assert.equal(B.win.S.privacy, true);
  assert.equal(B.calls.privacy, true);
  assert.equal(B.calls.hfx, 1, 'Appearance reloaded once for all its keys');
  assert.equal(B.get('mm.hfx.acc'), 'green');
  assert.equal(B.calls.reload, 0);
  B.later(50); A.later(50);
  A.ls.removeItem('mm.hfx.s');
  await A.sync(); await B.sync();
  assert.equal(B.get('mm.hfx.s'), null);
  assert.equal(B.calls.hfx, 2);
});

test('per-device settings are never sent or received', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net, { secret: 'sec' }), B = makeDevice(net);
  A.set('mm.sheetId', 'SHEET'); A.set('mm.auth.f', '3'); A.set('mm.auth.u', '999'); A.set('mm.lg.q', '[1]'); A.set('mm.bk.n', '4'); A.set('mm.theme', 'light');
  await A.sync(); await B.sync();
  assert.deepEqual(sentKeys(net), ['mm.theme']);
  assert.equal(B.get('mm.sheetId'), null);
  assert.equal(B.get('mm.lgSecret'), null);
  assert.ok(!net.log.some(l => (l.body || '').includes('SHEET') || (l.body || '').includes('"sec"') && false));
  const tab = settingsTab(c);
  assert.ok(tab.grid.slice(1).every(r => r[0] === 'mm.theme'));
});

test('a change that comes in from the sheet is not sent back (no echo), and a second round sends nothing', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net), B = makeDevice(net);
  A.set('mm.theme', 'dark'); await A.sync();
  await B.sync();
  assert.deepEqual([...B.api.status().dirty], []);
  const posts = sent(net).length;
  const r = await B.sync();
  assert.equal(sent(net).length, posts, 'B must not post anything');
  assert.deepEqual([...r.pushed], []);
  const rowT = settingsTab(c).grid[1][2];
  await A.sync();
  assert.equal(settingsTab(c).grid[1][2], rowT, 'time on the sheet unchanged');
});

test('the newest change wins when two devices change the same setting', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net), B = makeDevice(net);
  A.set('mm.hfx.dir', 'top'); await A.sync(); await B.sync();
  A.later(100); B.later(200);
  A.set('mm.hfx.dir', 'left');
  B.set('mm.hfx.dir', 'right');
  await A.sync(); await B.sync(); await A.sync();
  assert.equal(B.get('mm.hfx.dir'), 'right');
  assert.equal(A.get('mm.hfx.dir'), 'right');
  assert.equal(get(c, { action: 'settings' }).settings['mm.hfx.dir'].v, 'right');
});

test('first sync: this device keeps nothing over the sheet when both have a value, and sends values only it has', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net, { pre: { 'mm.theme': 'dark', 'mm.ss.prefs': '30d' } });
  await A.sync();
  const B = makeDevice(net, { pre: { 'mm.theme': 'light', 'mm.dense': '1' } });
  const rb = await B.sync();
  assert.equal(B.get('mm.theme'), 'dark', 'the sheet wins when both have a value and this device has no history');
  assert.equal(B.get('mm.ss.prefs'), '30d');
  assert.ok(rb.pushed.includes('mm.dense'));
  assert.equal(get(c, { action: 'settings' }).settings['mm.dense'].v, '1');
});

test('the login record syncs only when the script has a SECRET, and a damaged one never replaces a good one', async () => {
  // no secret: never sent, never taken
  const c0 = makeScript(), net0 = makeNet(c0);
  const A0 = makeDevice(net0), B0 = makeDevice(net0);
  A0.set('mm.auth.cred', CRED); A0.set('mm.theme', 'dark');
  await A0.sync(); await B0.sync();
  assert.ok(!sentKeys(net0).includes('mm.auth.cred'));
  assert.equal(B0.get('mm.auth.cred'), null);
  // with a secret: travels, and the lockout counters stay behind
  const c = makeScript({ secret: 'abc' }), net = makeNet(c);
  const A = makeDevice(net, { secret: 'abc' }), B = makeDevice(net, { secret: 'abc' });
  A.set('mm.auth.cred', CRED); A.set('mm.auth.f', '4');
  await A.sync(); await B.sync();
  assert.equal(B.get('mm.auth.cred'), CRED);
  assert.equal(B.get('mm.auth.f'), null);
  // damaged value on the sheet
  const C = makeDevice(net, { secret: 'abc', pre: { 'mm.auth.cred': CRED } });
  C.later(10);
  post(c, { secret: 'abc', action: 'settings_set', items: [{ k: 'mm.auth.cred', v: 'not json', t: Date.now() + 5000 }, { k: 'mm.theme', v: 'nonsense', t: Date.now() + 5000 }] });
  await C.sync();
  assert.equal(C.get('mm.auth.cred'), CRED);
  assert.equal(C.get('mm.theme'), null, 'an invalid theme value is ignored too');
});

test('a wrong secret leaves everything alone and reports the problem', async () => {
  const c = makeScript({ secret: 'abc' }), net = makeNet(c);
  const A = makeDevice(net, { secret: 'WRONG' });
  A.set('mm.theme', 'dark');
  const r = await A.sync();
  assert.equal(r.ok, false);
  assert.match(A.api.status().lastError, /auth/);
  assert.deepEqual([...A.api.status().dirty], ['mm.theme'], 'the change stays queued');
  assert.equal(A.get('mm.theme'), 'dark');
});

test('an old script, no link, or a non-https link means nothing is sent', async () => {
  const c = makeScript();
  const old = makeNet(c); old.infoOverride = { ok: true, service: 'my-money-entry', version: 3, edit: true };
  const A = makeDevice(old); A.set('mm.theme', 'dark');
  const r = await A.sync();
  assert.equal(r.ok, false);
  assert.equal(A.api.status().enabled, false);
  assert.match(A.api.status().lastError, /newest version/);
  assert.equal(sent(old).length, 0);
  const net = makeNet(c);
  const B = makeDevice(net, { url: 'http://script.google.com/macros/s/X/exec' }); B.set('mm.theme', 'dark');
  await B.sync();
  assert.equal(net.log.length, 0, 'plain http is never used');
  const D = makeDevice(net, { url: '' }); D.set('mm.theme', 'dark');
  await D.sync();
  assert.equal(net.log.length, 0);
  assert.equal(c.__created.length, 0);
});

test('when the network is down changes stay queued and go out on the next round', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net);
  A.set('mm.theme', 'dark');
  net.down = true;
  const r1 = await A.sync();
  assert.equal(r1.ok, false);
  assert.deepEqual([...A.api.status().dirty], ['mm.theme']);
  assert.match(A.api.status().lastError, /network/);
  net.down = false;
  const r2 = await A.sync();
  assert.equal(r2.ok, true);
  assert.deepEqual([...r2.pushed], ['mm.theme']);
  assert.deepEqual([...A.api.status().dirty], []);
});

test('a change made while a save is in flight is not lost', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net);
  A.set('mm.ss.prefs', '30d');
  const orig = net.fetch;
  let hit = false;
  net.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && !hit && /settings_set/.test(init.body || '')) { hit = true; A.later(20); A.set('mm.ss.prefs', '90d'); }
    return orig(url, init);
  };
  A.win.fetch = net.fetch;
  await A.sync();
  assert.deepEqual([...A.api.status().dirty], ['mm.ss.prefs'], 'the newer value is still waiting');
  await A.sync();
  assert.equal(get(c, { action: 'settings' }).settings['mm.ss.prefs'].v, '90d');
  assert.deepEqual([...A.api.status().dirty], []);
});

test('other settings reload the page once, only when idle, and never twice within a minute', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net), B = makeDevice(net);
  A.set('mm.dense', '1'); await A.sync(); await B.sync();
  assert.equal(B.calls.reload, 0, 'not immediately');
  B.later(3000);
  assert.equal(B.fireTimeout(2500), 1);
  assert.equal(B.calls.reload, 1);
  assert.ok(B.ss.getItem('mm.sync.rl'));
  A.later(100); B.later(100);
  A.set('mm.dense', '0'); await A.sync(); await B.sync();
  assert.equal(B.fireTimeout(2500), 0, 'no second reload timer inside a minute');
  assert.equal(B.calls.reload, 1);
  assert.ok(B.calls.toasts.some(t => /Reload to apply/.test(t)));
});

test('view filters and panel state are not synced, and a synced login record never triggers a reload', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net), B = makeDevice(net);
  A.set('mm.range', '30d'); A.set('mm.ap.drawer', '1'); A.set('mm.theme', 'dark');
  await A.sync();
  assert.deepEqual(sentKeys(net), ['mm.theme']);
  const cs = makeScript({ secret: 'abc' }), nets = makeNet(cs);
  const A2 = makeDevice(nets, { secret: 'abc' }), B2 = makeDevice(nets, { secret: 'abc' });
  A2.set('mm.auth.cred', CRED); await A2.sync(); await B2.sync();
  assert.equal(B2.get('mm.auth.cred'), CRED);
  B2.later(3000);
  assert.equal(B2.fireTimeout(2500), 0, 'no reload is scheduled for the login record');
  assert.equal(B2.calls.reload, 0);
});

test('it does not reload while you are typing or a panel is open', async () => {
  const c = makeScript(), net = makeNet(c);
  const A = makeDevice(net), B = makeDevice(net);
  A.set('mm.fold.on', '1'); await A.sync(); await B.sync();
  B.later(3000);
  B.doc.activeElement = { tagName: 'INPUT' };
  assert.equal(B.fireTimeout(2500), 1);
  assert.equal(B.calls.reload, 0);
  assert.ok(B.calls.toasts.some(t => /Reload to apply/.test(t)));
  const B2 = makeDevice(net);
  await B2.sync();
  B2.later(3000);
  B2.doc.overlay = { firstElementChild: {} };
  A.later(100); A.set('mm.fold.on', '0'); await A.sync(); B2.later(100); await B2.sync(); B2.later(3000);
  B2.fireTimeout(2500);
  assert.equal(B2.calls.reload, 0);
});

test('the hooks change nothing for the page: results, errors and other keys behave as before', () => {
  const net = makeNet(makeScript());
  const A = makeDevice(net);
  assert.equal(A.ls.setItem('mm.theme', 'dark'), undefined);
  A.ls.fail.add('mm.hfx.s');
  assert.throws(() => A.ls.setItem('mm.hfx.s', '5'), /quota/);
  assert.equal(A.metaOf()['mm.hfx.s'], undefined, 'a failed write is not counted as a change');
  A.ls.setItem('mm.lg.q', 'x');
  assert.equal(A.metaOf()['mm.lg.q'], undefined);
  A.ls.setItem('mm.theme', 'dark');
  const t1 = A.metaOf()['mm.theme'].t;
  A.ls.setItem('mm.theme', 'dark');
  assert.equal(A.metaOf()['mm.theme'].t, t1, 'writing the same value again is not a change');
  A.ss.setItem('mm.theme', 'light');
  assert.equal(A.ss.getItem('mm.theme'), 'light');
  assert.equal(A.metaOf()['mm.theme'].t, t1, 'sessionStorage is not watched');
});

/* ---------------- Part 3: the Appearance reload hook ---------------- */
function hfxEnv(initial = {}) {
  const store = new Map(Object.entries(initial)), attrs = new Map(), styles = new Map(), cls = new Set();
  const lStore = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const docEl = {
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
    style: { setProperty: (k, v) => styles.set(k, String(v)), getPropertyValue: k => styles.get(k) || '' },
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: k => (attrs.has(k) ? attrs.get(k) : null), removeAttribute: k => attrs.delete(k)
  };
  const sandbox = { document: { documentElement: docEl, addEventListener() {} }, localStorage: lStore, console, render() {} };
  sandbox.window = sandbox;
  vm.runInNewContext(hfxMatch[1], sandbox);
  return { sandbox, store, attrs, cls };
}
const st = e => ({ ...e.sandbox.window.__mmHfxState() });

test('Appearance reload picks up new saved choices and goes back to defaults for removed ones', () => {
  const e = hfxEnv();
  assert.equal(typeof e.sandbox.window.__mmHfxReload, 'function');
  assert.equal(st(e).s, 55);
  e.store.set('mm.hfx.s', '80'); e.store.set('mm.hfx.dir', 'top'); e.store.set('mm.hfx.acc', 'green');
  e.sandbox.window.__mmHfxReload();
  assert.deepEqual(st(e), { s: 80, dir: 'top', col: 'theme', acc: 'green', tile: 'default', out: 'default' });
  assert.equal(e.attrs.get('data-hfx-dir'), 'top');
  assert.equal(e.attrs.get('data-accent'), 'green');
  e.store.delete('mm.hfx.s'); e.store.delete('mm.hfx.dir'); e.store.delete('mm.hfx.acc');
  e.sandbox.window.__mmHfxReload();
  assert.deepEqual(st(e), { s: 55, dir: 'bottom', col: 'theme', acc: 'blue', tile: 'default', out: 'default' });
  e.store.set('mm.hfx.s', '0'); e.sandbox.window.__mmHfxReload();
  assert.ok(e.cls.has('mm-fx-off'));
  e.store.set('mm.hfx.dir', 'bogus'); e.sandbox.window.__mmHfxReload();
  assert.equal(st(e).dir, 'bottom', 'invalid values are ignored');
});

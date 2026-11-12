// Run with: node --test tests/fast-start.test.mjs
// Loads the REAL fast-start helpers and loadViaScript out of index.html (no copies) into a sandbox with a fake browser, and proves:
//  - the saved copy of the sheet is only ever shown to a signed-in owner (never a guest, never before sign-in), only for the same script link,
//    and only while a sign-in key is still saved
//  - it is ignored and deleted when it is too old, from the future, corrupted or the wrong shape, and a full or blocked device store never throws
//  - it is deleted on sign-out, is not part of backup files, and is the first thing dropped when device storage is full
//  - the Refresh button's "fresh" request is sent exactly once, and a good read is remembered only after it passed every check
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
function constLine(name) { const m = html.match(new RegExp('^const ' + name + '=.*$', 'm')); if (!m) throw new Error(name + ' not found'); return m[0]; }
function fnBlock(name, prefix = '') {
  const start = html.indexOf(prefix + 'function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  let i = html.indexOf('{', html.indexOf(')', start)), d = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') d++;
    else if (html[i] === '}') { d--; if (d === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
const plain = x => JSON.parse(JSON.stringify(x));

const URL1 = 'https://script.google.com/macros/s/AKfycbxEXAMPLE/exec';
const RAW = () => ({ A: { sheet: 'A', headers: ['x'], rows: [{ x: 1, _row: 2 }] }, B: { sheet: 'B', headers: ['y'], rows: [] } });

function make(opts = {}) {
  const ls = new Map(), ss = new Map(), calls = { fetchBodies: [] };
  const state = { guest: !!opts.guest, secret: opts.secret === undefined ? 'tok' : opts.secret, authed: opts.authed !== false, setThrows: false, now: 1_700_000_000_000 };
  if (state.authed) ss.set('user_authenticated', 'true');
  const ctx = vm.createContext({
    window: {},
    Date: class extends Date { static now() { return state.now; } },
    localStorage: {
      getItem: k => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => { if (state.setThrows) throw new Error('QuotaExceededError'); ls.set(k, String(v)); },
      removeItem: k => { ls.delete(k); }
    },
    sessionStorage: { getItem: k => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)), removeItem: k => ss.delete(k) },
    LS: { get: k => (k === 'lgSecret' ? state.secret : '') },
    mmAuthFail: () => {},
    fetch: async (url, init) => { calls.fetchBodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true, tabs: opts.reply || { A: { sheet: 'A', headers: ['x'], rows: [] }, B: { sheet: 'B', headers: ['y'], rows: [] } } }) }; }
  });
  if (state.guest) ctx.window.mmGuest = { active: true };
  vm.runInContext([
    "const TABS={A:'A',B:'B'}; const EXTRA_TABS={};",
    constLine('FAST_START'),
    constLine('mmRcClear'),
    fnBlock('mmRcSave'),
    fnBlock('mmRcRead'),
    'let _mmFresh=false;',
    fnBlock('loadViaScript', 'async '),
    'globalThis.__t={mmRcSave,mmRcRead,mmRcClear,loadViaScript,RC_KEY,RC_MAX_AGE,setFresh(){_mmFresh=true}};'
  ].join('\n'), ctx);
  return { t: ctx.__t, ls, ss, state, calls };
}

test('a saved copy comes back for the signed-in owner, with the time it was saved', () => {
  const { t, state } = make();
  t.mmRcSave(URL1, RAW());
  state.now += 5000;
  const c = t.mmRcRead(URL1);
  assert.deepEqual(plain(c.raw), RAW());
  assert.equal(c.t, 1_700_000_000_000);
});

test('a guest never saves and never reads a saved copy', () => {
  const g = make({ guest: true });
  g.t.mmRcSave(URL1, RAW());
  assert.equal(g.ls.size, 0, 'a guest wrote something to device storage');
  const o = make();
  o.t.mmRcSave(URL1, RAW());
  const g2 = make({ guest: true });
  g2.ls.set('mm.rc.v1', o.ls.get('mm.rc.v1'));
  assert.equal(g2.t.mmRcRead(URL1), null);
});

test('nothing is shown before the sign-in gate has been passed in this tab', () => {
  const a = make();
  a.t.mmRcSave(URL1, RAW());
  a.ss.delete('user_authenticated');
  assert.equal(a.t.mmRcRead(URL1), null);
  const b = make({ authed: false });
  b.ls.set('mm.rc.v1', a.ls.get('mm.rc.v1'));
  assert.equal(b.t.mmRcRead(URL1), null);
  b.ss.set('user_authenticated', 'false');
  assert.equal(b.t.mmRcRead(URL1), null);
});

test('without a saved sign-in key nothing is saved or shown', () => {
  const n = make({ secret: '' });
  n.t.mmRcSave(URL1, RAW());
  assert.equal(n.ls.size, 0);
  const a = make();
  a.t.mmRcSave(URL1, RAW());
  a.state.secret = '';
  assert.equal(a.t.mmRcRead(URL1), null);
  assert.equal(a.t.mmRcRead(''), null);
  assert.equal(a.t.mmRcRead(undefined), null);
});

test('a different script link never sees another link\'s data, and the old copy is deleted', () => {
  const { t, ls } = make();
  t.mmRcSave(URL1, RAW());
  assert.equal(t.mmRcRead('https://script.google.com/macros/s/OTHER/exec'), null);
  assert.equal(ls.has('mm.rc.v1'), false);
});

test('a copy older than 3 days, or dated in the future, is ignored and deleted', () => {
  for (const shift of [3 * 864e5 + 1000, -10 * 60000]) {
    const { t, state, ls } = make();
    t.mmRcSave(URL1, RAW());
    state.now += shift;
    assert.equal(t.mmRcRead(URL1), null, 'shift ' + shift);
    assert.equal(ls.has('mm.rc.v1'), false);
  }
  const { t, state } = make();
  t.mmRcSave(URL1, RAW());
  state.now += 3 * 864e5 - 1000;
  assert.ok(t.mmRcRead(URL1), 'just under 3 days should still be used');
});

test('corrupted or wrong-shaped copies are ignored and deleted', () => {
  const bad = ['{not json', 'null', '[]', '"str"', JSON.stringify({ u: URL1, t: 1_700_000_000_000 }),
    JSON.stringify({ u: URL1, t: 1_700_000_000_000, raw: { A: { headers: [], rows: [] } } }),                 // tab B missing
    JSON.stringify({ u: URL1, t: 1_700_000_000_000, raw: { A: { headers: [], rows: 'x' }, B: { headers: [], rows: [] } } }),
    JSON.stringify({ u: URL1, t: 'now', raw: RAW() }), JSON.stringify({ u: URL1, t: -5, raw: RAW() })];
  for (const s of bad) {
    const { t, ls } = make();
    ls.set('mm.rc.v1', s);
    assert.equal(t.mmRcRead(URL1), null, s.slice(0, 40));
    assert.equal(ls.has('mm.rc.v1'), false, 'not deleted: ' + s.slice(0, 40));
  }
});

test('a full or blocked device store never throws and leaves no half copy behind', () => {
  const { t, state, ls } = make();
  t.mmRcSave(URL1, RAW());
  state.setThrows = true;
  assert.doesNotThrow(() => t.mmRcSave(URL1, RAW()));
  assert.equal(ls.has('mm.rc.v1'), false);
});

test('Refresh sends fresh exactly once; ordinary reads never do', async () => {
  const { t, calls } = make();
  await t.loadViaScript(URL1, { A: 'A', B: 'B' });
  t.setFresh();
  await t.loadViaScript(URL1, { A: 'A', B: 'B' });
  await t.loadViaScript(URL1, { A: 'A', B: 'B' });
  assert.deepEqual(calls.fetchBodies.map(b => b.fresh === true), [false, true, false]);
  assert.ok(calls.fetchBodies.every(b => b.action === 'read' && b.secret === 'tok'));
});

test('a good read is remembered; a failed or refused read is not', async () => {
  const ok = make();
  await ok.t.loadViaScript(URL1, { A: 'A', B: 'B' });
  assert.ok(ok.ls.has('mm.rc.v1'));
  const missingTab = make({ reply: { A: { sheet: 'A', headers: [], rows: [] }, B: { sheet: 'B', headers: [], rows: [], missing: true } } });
  await assert.rejects(() => missingTab.t.loadViaScript(URL1, { A: 'A', B: 'B' }));
  assert.equal(missingTab.ls.has('mm.rc.v1'), false, 'a read that failed a check must not be remembered');
});

/* ---------- things that must hold in the page itself ---------- */

test('signing out (and an expired sign-in, which signs out) deletes the saved copy', () => {
  const m = html.match(/function signOut\(skipServer\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'signOut found');
  assert.match(m[0], /lsDel\('mm\.rc\.v1'\)/);
  assert.ok(m[0].indexOf("lsDel('mm.rc.v1')") < m[0].indexOf('location.reload()'), 'must be deleted before the page reloads');
  const e = html.match(/function expired\(\) \{[\s\S]*?\n  \}/);
  assert.match(e[0], /signOut\(true\)/, 'an expired sign-in goes through signOut');
});

test('clearing the connection deletes the saved copy', () => {
  assert.match(html, /toast\(u\?'Connection saved':'Connection cleared'\);if\(!u\)mmRcClear\(\);/);
});

test('the saved copy is not in backup files, and is the first thing dropped when storage is full', () => {
  const dl = fnBlock('downloadBackup');
  assert.ok(!/rc\.v1|mm\.rc/.test(dl));
  assert.match(dl, /allowed=\['lg\.q','lg\.hist','lgUrl','range','theme'\]/);
  assert.match(html, /b==='rc\.v1'\)rm\.push\(k\)/);
});

test('the saved copy is written straight to device storage, never through LS (which could evict saved entries)', () => {
  const save = fnBlock('mmRcSave');
  assert.match(save, /localStorage\.setItem\(RC_KEY/);
  assert.ok(!/LS\.set/.test(save));
});

test('boot shows the saved copy after the empty screen and before the live read starts', () => {
  const boot = html.slice(html.indexOf('(function boot(){'));
  const a = boot.indexOf('store.set(embeddedRaw(),EmbeddedSource);');
  const b = boot.indexOf('mmRcRead(LS.get(\'lgUrl\'))');
  const c = boot.indexOf('store.load(GoogleSheetSource(sid||\'\'))');
  assert.ok(a > 0 && b > a && c > b, `order ${a} ${b} ${c}`);
  assert.match(boot, /catch\(e\)\{store\.__at=null;mmRcClear\(\);store\.set\(embeddedRaw\(\),EmbeddedSource\)\}/);
});

test('the saved copy carries its real age (store.set uses it for "synced ... ago")', () => {
  assert.match(html, /this\.syncedAt=this\.__at\|\|new Date\(\);this\.__at=null;/);
});

test('the Refresh button asks for a fresh read', () => {
  assert.match(fnBlock('doRefresh'), /_mmFresh=true/);
});

test('the preconnect hints exist and send no data', () => {
  assert.match(html, /<link rel="preconnect" href="https:\/\/script\.google\.com" crossorigin>/);
  assert.match(html, /<link rel="preconnect" href="https:\/\/script\.googleusercontent\.com" crossorigin>/);
});

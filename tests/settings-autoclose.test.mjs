// Checks for the settings menu auto-close script ("mm-settings-autoclose"). Run: node --test tests/settings-autoclose.test.mjs
// Runs the REAL script from index.html against a fake page and fake storage. Never touches the sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = html.match(/<script id="mm-settings-autoclose">([\s\S]*?)<\/script>/)[1];

function boot(saved = {}) {
  const store = new Map(Object.entries(saved));
  let settingsUp = false, observer = null; const listeners = {};
  const ctx = {
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    document: { readyState: 'complete', getElementById: id => (id === 'overlay' ? {} : null), querySelector: sel => (sel === '#overlay .m3-scope' && settingsUp ? {} : null), addEventListener() {} },
    MutationObserver: function (cb) { observer = cb; this.observe = () => {}; },
    addEventListener: (n, f) => { listeners[n] = f; }
  };
  ctx.window = ctx;
  vm.runInNewContext(src, ctx);
  return { ctx, store, listeners, setUp(v) { settingsUp = v; observer && observer(); } };
}
const OPEN = { 'mm.setfold': '["Appearance"]', 'mm.ap.drawer': '1', 'mm.ap.drawer3': '1', 'mm.ap.tab': 'chart', 'mm.hfx.line': '40', 'mm.theme': 'dark' };

test('closing the settings menu clears only the open-section lists', () => {
  const t = boot(OPEN); t.setUp(true);
  assert.equal(t.store.get('mm.setfold'), OPEN['mm.setfold'], 'opening changes nothing');
  t.setUp(false);
  for (const k of ['mm.setfold', 'mm.ap.drawer', 'mm.ap.drawer3']) assert.equal(t.store.has(k), false, k);
  for (const k of ['mm.ap.tab', 'mm.hfx.line', 'mm.theme']) assert.equal(t.store.get(k), OPEN[k], k + ' is untouched');
});

test('sections opened while the menu is up are kept until it closes', () => {
  const t = boot(); t.setUp(true); t.store.set('mm.setfold', '["Local Security"]');
  t.setUp(true); assert.equal(t.store.get('mm.setfold'), '["Local Security"]');
  t.setUp(false); assert.equal(t.store.has('mm.setfold'), false);
});

test('nothing is cleared when the menu was never open (so a saved state is not wiped at page load)', () => {
  const t = boot(OPEN); t.setUp(false);
  assert.equal(t.store.get('mm.setfold'), OPEN['mm.setfold']);
});

test('leaving the page with the menu open also closes everything for next time', () => {
  const t = boot(OPEN); t.setUp(true); t.listeners.pagehide();
  assert.equal(t.store.has('mm.setfold'), false); assert.equal(t.store.has('mm.ap.drawer3'), false);
  const u = boot(OPEN); u.listeners.pagehide();   // menu not open: leave the saved lists alone
  assert.equal(u.store.get('mm.setfold'), OPEN['mm.setfold']);
});

test('the script is wired to the real overlay element and the real storage keys', () => {
  assert.ok(/<div id="overlay"><\/div>/.test(html));
  assert.ok(/getItem\('mm\.setfold'\)|STORAGE_KEY = 'mm\.setfold'/.test(html));
  assert.ok(/localStorage\.getItem\('mm\.ap\.drawer'\)/.test(html) && /K_DRAWER = 'mm\.ap\.drawer3'/.test(html));
});

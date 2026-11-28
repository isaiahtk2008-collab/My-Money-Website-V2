// Static + behaviour checks for the "Line thickness" slider (Security & Settings > Appearance > Fine tuning). Run: node --test tests/line-thickness.test.mjs
// Runs the REAL "mm-appearance-v3-core" script from index.html against a fake page and fake storage. Never touches the sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const gs = fs.readFileSync(new URL('../apps-script.gs', import.meta.url), 'utf8');
const core = html.match(/<script id="mm-appearance-v3-core">([\s\S]*?)<\/script>/)[1];
const KEY = 'mm.hfx.line';

function boot(saved = {}) {
  const store = new Map(Object.entries(saved));
  const attrs = new Map(), props = new Map();
  const root = {
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k),
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) }
  };
  const ctx = {
    document: { documentElement: root },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
  };
  ctx.window = ctx;
  vm.runInNewContext(core, ctx);
  return { C: ctx.__mmAp3Core, attrs, props, store };
}

test('no border or outline in the page hardcodes 1px any more (every one has the var with a 1px fallback)', () => {
  assert.equal((html.match(/(?<!var\(--ap3-w,)1px (solid|dashed)/g) || []).length, 0);
  assert.ok((html.match(/var\(--ap3-w,1px\) (solid|dashed)/g) || []).length >= 80);
});

test('the fallback is 1px, so with nothing set every line looks exactly as before', () => {
  assert.ok(!/--ap3-w\s*:/.test(html.replace(/'--ap3-w'/g, '')), 'the variable is only ever set from script, never in a stylesheet');
  assert.ok(/border:var\(--ap3-w,1px\) solid var\(--ap3-lc,var\(--line,#2a303b\)\)/.test(html), 'the expiry banner card uses it too');
});

test('focus rings and status stripes keep their own widths (not scaled away)', () => {
  assert.ok(/:focus-visible\{outline:3px solid/.test(html));
  assert.ok(/:focus-visible\{outline:2px solid var\(--accent\);outline-offset:2px/.test(html));
  assert.ok(/border-left: 3px solid var\(--bad\)/.test(html));
});

test('100% (or nothing saved) sets no attribute and no variable', () => {
  let { attrs, props, C } = boot();
  assert.equal(C.cur.line, 100); assert.equal(attrs.has('data-ap3-line'), false); assert.equal(props.has('--ap3-w'), false);
  ({ attrs, props, C } = boot({ [KEY]: '100' }));
  assert.equal(C.cur.line, 100); assert.equal(props.has('--ap3-w'), false);
});

test('saved values map to 0px through 6px; below one screen pixel the line stays 1 screen pixel wide and fades', () => {
  for (const [v, px] of [['0', '0.000px'], ['150', '1.500px'], ['300', '3.000px'], ['600', '6.000px']]) {
    const { attrs, props } = boot({ [KEY]: v });
    assert.equal(attrs.get('data-ap3-line'), '1'); assert.equal(props.get('--ap3-w'), px, v);
    assert.equal(attrs.has('data-ap3-fade'), false, v); assert.equal(props.has('--ap3-lc'), false, v);
  }
  for (const [v, pct] of [['1', 4], ['10', 10], ['50', 50], ['99', 99]]) {   // 1 is floored at 4% so it never vanishes; 0 is the real "None"
    const { attrs, props } = boot({ [KEY]: v });
    assert.equal(props.get('--ap3-w'), '1.000px', v); assert.equal(attrs.get('data-ap3-fade'), '1', v);
    assert.equal(props.get('--ap3-fp'), pct + '%', v);
    assert.ok(props.get('--ap3-lc').includes(pct + '%'), v);
  }
});

test('on a sharper screen the true thin width is used before any fading', () => {
  const store = new Map([[KEY, '50']]), attrs = new Map(), props = new Map();
  const ctx = { devicePixelRatio: 3, document: { documentElement: { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k), style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) } } },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) } };
  ctx.window = ctx; vm.runInNewContext(core, ctx);
  assert.equal(props.get('--ap3-w'), '0.500px'); assert.equal(attrs.has('data-ap3-fade'), false);   // 0.5px is 1.5 screen pixels, so no fade
  store.set(KEY, '20'); ctx.__mmAp3Core.load(); ctx.__mmAp3Core.apply();
  assert.equal(props.get('--ap3-w'), '0.333px'); assert.equal(props.get('--ap3-fp'), '60%');   // 0.2px is 0.6 screen pixel: one screen pixel, 60% strength
});

test('out-of-range or non-numeric saved values are ignored', () => {
  for (const bad of ['601', '-5', 'abc', '1e2', '', '12.5', '9999']) {
    const { C, props } = boot({ [KEY]: bad });
    assert.equal(C.cur.line, 100, bad); assert.equal(props.has('--ap3-w'), false, bad);
  }
});

test('saveNum stores a change, and going back to 100% stores nothing; apply is reversible', () => {
  const { C, store, props } = boot();
  C.cur.line = 0; C.apply(); C.saveNum('line');
  assert.equal(store.get(KEY), '0'); assert.equal(props.get('--ap3-w'), '0.000px');
  C.cur.line = 30; C.apply(); assert.equal(props.get('--ap3-fp'), '30%');
  C.cur.line = C.def.line; C.apply(); C.saveNum('line');
  assert.equal(store.has(KEY), false); assert.equal(props.has('--ap3-w'), false);
  assert.equal(props.has('--ap3-lc'), false); assert.equal(props.has('--ap3-fp'), false);
});

test('it is a normal Fine tuning row: listed, 0 to 600, "None" at 0, and Reset fine tuning loops every name', () => {
  const { C } = boot();
  assert.ok(C.names.includes('line')); assert.equal(JSON.stringify(C.range.line), '[0,600]'); assert.equal(C.def.line, 100);
  assert.ok(/line: \['Line thickness', '[^']*100% is the current look/.test(html));
  assert.ok(/n === 'line' && v === 0\) return 'None'/.test(html));
  assert.ok(/function resetFine\(\) \{ for \(var i = 0; i < NAMES\.length; i\+\+\)/.test(html));
});

test('syncs to your other devices: in the settings sync list and in the Apps Script allow-list (the script needs the manual update)', () => {
  assert.ok(/'mm\.hfx\.line'/.test(gs.match(/const SETTINGS_ALLOWED = \[([\s\S]*?)\];/)[1]));
  const sync = html.match(/var KEYS = \[([\s\S]*?)\];/)[1];
  assert.ok(/'mm\.hfx\.line'/.test(sync));
});

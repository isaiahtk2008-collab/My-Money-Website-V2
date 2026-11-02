// Static checks for the hover effects (enlarge + under-glow) and the Appearance settings (glow strength, direction, color, Reset). Run: node --test tests/hover-fx.test.mjs
// Guards the safety rules: every rule sits behind the off switch, only on real hover pointers, and never touches the modal
// backdrop, SVG chart slices, text boxes (no resize) or table cells (no transform). Never touches the sheet.
// The script tests run the real settings script in a fake page. (Drafted by Gemini, reviewed and wired up by Claude.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cssMatch = html.match(/<style id="mm-hover-fx">([\s\S]*?)<\/style>/);
const jsMatch = html.match(/<script id="mm-hover-fx-js">([\s\S]*?)<\/script>/);

function parseRules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [], stack = [];
  let i = 0, prelude = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const p = prelude.trim();
      if (p.startsWith('@')) { stack.push(p); prelude = ''; i++; continue; }
      const end = css.indexOf('}', i);
      rules.push({ selector: p, body: css.slice(i + 1, end), at: stack.slice() });
      prelude = ''; i = end + 1; continue;
    }
    if (ch === '}') { stack.pop(); prelude = ''; i++; continue; }
    prelude += ch; i++;
  }
  return rules;
}
function splitTop(sel) {
  const parts = []; let d = 0, cur = '';
  for (const c of sel) {
    if (c === '(' || c === '[') d++;
    if (c === ')' || c === ']') d--;
    if (c === ',' && d === 0) { parts.push(cur.trim()); cur = ''; } else cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

test('style and script blocks exist exactly once', () => {
  assert.ok(cssMatch, 'style block missing');
  assert.ok(jsMatch, 'script block missing');
  assert.equal((html.match(/id="mm-hover-fx"/g) || []).length, 1);
  assert.equal((html.match(/id="mm-hover-fx-js"/g) || []).length, 1);
});

test('every rule is behind the off switch and only applies to real hover pointers', () => {
  const rules = parseRules(cssMatch[1]);
  assert.ok(rules.length >= 12, 'expected the full rule set, got ' + rules.length);
  for (const r of rules) {
    for (const part of splitTop(r.selector)) {
      assert.ok(part.startsWith('html:not(.mm-fx-off)'), 'rule not behind the off switch: ' + part.slice(0, 80));
    }
    const media = r.at.join(' ');
    assert.ok(/hover:hover/.test(media) && /pointer:fine/.test(media), 'rule outside the hover media query: ' + r.selector.slice(0, 80));
  }
});

test('dangerous targets are never styled', () => {
  const rules = parseRules(cssMatch[1]);
  const all = rules.map(r => r.selector).join('\n');
  const forbidden = [/\.dh-seg(?![-\w])/, /\.overlay(?![-\w])/, /scrim/, /#auth-modal/, /\.ss-pop(?![-\w])/, /data-tip/, /\.ic(?![-\w])/];
  for (const re of forbidden) assert.ok(!re.test(all), 'must not target ' + re);
  // a bare [data-act] (which the modal backdrop carries) is only allowed on table rows; everywhere else it must be button[data-act]
  for (const r of rules) {
    for (const m of r.selector.matchAll(/(.)\[data-act\]/g)) {
      const before = r.selector.slice(0, m.index + 1);
      assert.ok(m[1] === 'n' && /button$/.test(before) || /tbody tr:is\(\[data-act\]/.test(r.selector), 'bare [data-act] in: ' + r.selector.slice(0, 90));
    }
  }
});

test('only buttons and controls enlarge: no transform on table parts or text boxes', () => {
  const rules = parseRules(cssMatch[1]);
  const scaled = rules.filter(r => /transform\s*:/.test(r.body));
  assert.ok(scaled.length >= 6);
  for (const r of scaled) {
    assert.ok(!/\b(tr|td|th|textarea)\b/.test(r.selector.replace(/\[[^\]]*\]/g, '')), 'transform on table/text part: ' + r.selector.slice(0, 90));
    assert.ok(!/input\[type="(text|search|password|email|number|date|time|tel|url)"\]/.test(r.selector), 'text box would resize: ' + r.selector.slice(0, 90));
  }
});

test('reduced motion removes the enlarge but keeps the glow', () => {
  assert.match(cssMatch[1], /prefers-reduced-motion:reduce\)\{html:not\(\.mm-fx-off\)\{--hfx-m:0\}/);
  for (const r of parseRules(cssMatch[1]).filter(r => /transform\s*:/.test(r.body))) {
    assert.match(r.body, /--hfx-m/, 'transform ignores reduced motion: ' + r.selector.slice(0, 80));
  }
});

test('settings hook sits between the Status card and the Sheet Sync card', () => {
  const a = html.indexOf("window.__mmStatusSettingsHtml==='function'?window.__mmStatusSettingsHtml()");
  const b = html.indexOf("window.__mmHoverFxSettingsHtml==='function'?window.__mmHoverFxSettingsHtml()");
  const c = html.indexOf('Sheet Sync Connection</div>');
  assert.ok(a > 0 && b > a && c > b, 'hook order wrong');
  assert.equal((html.match(/__mmHoverFxSettingsHtml==='function'/g) || []).length, 1);
});

// ---- the Appearance variables (glow strength, direction, color) ----
const apMatch = html.match(/<style id="mm-appearance">([\s\S]*?)<\/style>/);
const apCss = apMatch ? apMatch[1] : '';

test('appearance style block exists exactly once', () => {
  assert.equal((html.match(/id="mm-appearance"/g) || []).length, 1);
  assert.ok(apMatch, 'style block missing');
});

test('defaults reproduce the original look exactly', () => {
  for (const s of ['--hfx-s:55', '--hfx-dy:6px', '--hfx-c:var(--accent)', '--hfx-sp:-4px', 'calc(16px', 'calc(12px', 'calc(8px', '9 / 11']) {
    assert.ok(apCss.includes(s), 'missing ' + s);
  }
});

test('every direction and color preset has a rule (theme follows the accent, so it has none)', () => {
  for (const d of ['bottom', 'top', 'left', 'right', 'all']) assert.ok(apCss.includes(':root[data-hfx-dir="' + d + '"]'), 'direction ' + d);
  for (const c of ['blue', 'green', 'purple', 'orange', 'white']) assert.ok(apCss.includes(':root[data-hfx-col="' + c + '"]'), 'color ' + c);
  assert.ok(!apCss.includes('data-hfx-col="theme"'));
});

test('preset colors are the agreed ones', () => {
  const agreed = { blue: '#3b82f6', green: '#22c55e', purple: '#a855f7', orange: '#f97316', white: '#ffffff' };
  const rules = parseRules(apCss);
  for (const [col, hex] of Object.entries(agreed)) {
    const rule = rules.find((r) => r.selector === ':root[data-hfx-col="' + col + '"]');
    assert.ok(rule, 'rule missing for ' + col);
    assert.ok(rule.body.includes(hex), col + ' should be ' + hex);
  }
});

test('hover rules use the shared glow variables and no longer hard-code the accent', () => {
  const css = cssMatch[1];
  for (const v of ['var(--hfx-glow)', 'var(--hfx-glow-s)', 'var(--hfx-drop)', 'var(--hfx-c)']) assert.ok(css.includes(v), 'hover rules should use ' + v);
  assert.ok(!css.includes('--hfx-glow:'), 'glow definitions moved to the appearance block');
  assert.ok(!css.includes('color-mix(in srgb,var(--accent) 22%'), 'text box glow should follow the glow color');
});

test('the appearance block holds only variables and card styles (no hover rules)', () => {
  assert.ok(!apCss.includes(':hover'));
  assert.ok(!apCss.includes('transform:'));
});

// ---- script behaviour (run in a fake page: no real browser) ----
// makeEnv runs the real <script id="mm-hover-fx-js"> against a stand-in for <html> and localStorage.
function makeEnv(stored = {}, throwing = false) {
  const store = new Map(Object.entries(stored || {}));
  const cls = new Set();
  const attrs = new Map();
  const styles = new Map();
  const handlers = [];

  const lStore = {
    getItem(k) {
      if (throwing) throw new Error('Storage disabled');
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      if (throwing) throw new Error('Storage disabled');
      store.set(k, String(v));
    },
    removeItem(k) {
      if (throwing) throw new Error('Storage disabled');
      store.delete(k);
    },
  };

  const docEl = {
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
    },
    style: {
      setProperty: (k, v) => styles.set(k, String(v)),
      getPropertyValue: (k) => styles.get(k) || '',
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
  };

  const sandbox = {
    document: {
      documentElement: docEl,
      addEventListener: (t, f) => handlers.push([t, f]),
    },
    localStorage: lStore,
    console,
    redraws: 0,
    render() { sandbox.redraws++; },
  };
  sandbox.window = sandbox;

  vm.runInNewContext(jsMatch[1], sandbox);
  return { sandbox, cls, attrs, styles, handlers, store };
}

// copied into a normal object: the page's own object comes from another vm realm, which strict deepEqual would reject
const stateOf = (env) => ({ ...env.sandbox.window.__mmHfxState() });

function handler(env, type) {
  const entry = env.handlers.find(([t]) => t === type);
  return entry ? entry[1] : null;
}

// A fake Appearance card: slider, label, status line, 5 direction chips, 6 color chips and the Reset button.
function mkCard() {
  const slider = {
    id: 'hfx-s',
    value: '55',
    aria: {},
    setAttribute(k, v) { this.aria[k] = String(v); },
  };
  const out = { textContent: '' };
  const st = { className: '', textContent: '' };

  const makeBtn = (attrName, attrVal) => {
    const btn = {
      aria: {},
      getAttribute(k) {
        if (k === attrName) return attrVal;
        return this.aria[k] !== undefined ? this.aria[k] : null;
      },
      setAttribute(k, v) { this.aria[k] = String(v); },
      closest(sel) {
        if (sel === '#hfx-card button') return btn;
        if (sel === '#hfx-card') return card;
        return null;
      },
    };
    return btn;
  };

  const dirBtns = ['bottom', 'top', 'left', 'right', 'all'].map((d) => makeBtn('data-hfx-dir', d));
  const colBtns = ['theme', 'blue', 'green', 'purple', 'orange', 'white'].map((c) => makeBtn('data-hfx-col', c));
  const accBtns = ['blue', 'green', 'purple', 'orange', 'rose', 'teal'].map((a) => makeBtn('data-hfx-acc', a));
  const tileBtns = ['default', 'cream', 'mint', 'lavender', 'sky', 'graphite'].map((t) => makeBtn('data-hfx-tile', t));
  const outBtns = ['default', 'soft', 'strong', 'accent'].map((o) => makeBtn('data-hfx-out', o));
  const resetBtn = makeBtn('data-hfx-reset', '1');
  slider.closest = (sel) => (sel === '#hfx-card' ? card : null);

  const card = {
    querySelector(sel) {
      if (sel === '#hfx-s') return slider;
      if (sel === '#hfx-sv') return out;
      if (sel === '#hfx-st') return st;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'button[data-hfx-dir]') return dirBtns;
      if (sel === 'button[data-hfx-col]') return colBtns;
      if (sel === 'button[data-hfx-acc]') return accBtns;
      if (sel === 'button[data-hfx-tile]') return tileBtns;
      if (sel === 'button[data-hfx-out]') return outBtns;
      return [];
    },
  };
  return { card, slider, out, st, dirBtns, colBtns, accBtns, tileBtns, outBtns, resetBtn };
}

function clickBtn(env, btn) {
  const fn = handler(env, 'click');
  fn({ target: { closest: (sel) => btn.closest(sel) } });
}

function slide(env, c, value) {
  const fn = handler(env, 'input');
  fn({
    target: {
      id: 'hfx-s',
      value: String(value),
      setAttribute: (k, v) => c.slider.setAttribute(k, v),
      closest: (sel) => (sel === '#hfx-card' ? c.card : null),
    },
  });
}

const pick = (c, kind, v) => c[{ dir: 'dirBtns', col: 'colBtns', acc: 'accBtns', tile: 'tileBtns', out: 'outBtns' }[kind]].find((b) => b.getAttribute('data-hfx-' + kind) === v);

test('script: defaults are strength 55, bottom, match theme, and the effect is on', () => {
  const env = makeEnv({});
  assert.equal(env.cls.has('mm-fx-off'), false);
  assert.deepEqual(stateOf(env), { s: 55, dir: 'bottom', col: 'theme', acc: 'blue', tile: 'default', out: 'default' });
  assert.equal(env.styles.get('--hfx-s'), '55');
  assert.equal(env.attrs.get('data-hfx-dir'), 'bottom');
  assert.equal(env.attrs.get('data-hfx-col'), 'theme');
});

test('script: the old On/Off choice and saved strength are honoured', () => {
  let env = makeEnv({ 'mm.hoverfx': '0' });
  assert.equal(env.cls.has('mm-fx-off'), true);
  assert.equal(stateOf(env).s, 0);
  env = makeEnv({ 'mm.hoverfx': '1' });
  assert.equal(env.cls.has('mm-fx-off'), false);
  assert.equal(stateOf(env).s, 55);
  env = makeEnv({ 'mm.hfx.s': '0' });
  assert.equal(env.cls.has('mm-fx-off'), true);
  assert.equal(stateOf(env).s, 0);
  env = makeEnv({ 'mm.hfx.s': '80', 'mm.hoverfx': '0' });
  assert.equal(env.cls.has('mm-fx-off'), false);
  assert.equal(stateOf(env).s, 80);
});

test('script: garbage in storage falls back to the defaults (or clamps)', () => {
  for (const bad of ['abc', '-5', '7x', '']) assert.equal(stateOf(makeEnv({ 'mm.hfx.s': bad })).s, 55, 'strength ' + JSON.stringify(bad));
  assert.equal(stateOf(makeEnv({ 'mm.hfx.s': 'abc', 'mm.hoverfx': '0' })).s, 0);
  assert.equal(stateOf(makeEnv({ 'mm.hfx.s': '150' })).s, 100);
  const env = makeEnv({ 'mm.hfx.dir': 'diagonal', 'mm.hfx.col': 'pink' });
  assert.equal(stateOf(env).dir, 'bottom');
  assert.equal(stateOf(env).col, 'theme');
});

test('script: blocked storage never throws and stays on with the defaults', () => {
  let env;
  assert.doesNotThrow(() => { env = makeEnv(null, true); });
  assert.deepEqual(stateOf(env), { s: 55, dir: 'bottom', col: 'theme', acc: 'blue', tile: 'default', out: 'default' });
  assert.equal(env.cls.has('mm-fx-off'), false);
  assert.match(env.sandbox.window.__mmHoverFxSettingsHtml(), /id="hfx-card"/);
  // changing things still works for this visit even though nothing can be saved
  const c = mkCard();
  assert.doesNotThrow(() => { slide(env, c, 0); clickBtn(env, pick(c, 'dir', 'top')); clickBtn(env, c.resetBtn); });
});

test('script: the card has a slider, 5 directions, 6 colors, a preview and Reset (no On/Off buttons)', () => {
  const h = makeEnv({ 'mm.hfx.dir': 'left', 'mm.hfx.col': 'orange', 'mm.hfx.s': '0' }).sandbox.window.__mmHoverFxSettingsHtml();
  assert.ok(!h.includes('data-hfx="1"') && !h.includes('data-hfx="0"'), 'old On/Off buttons are back');
  assert.match(h, /<section class="m3-card" id="hfx-card">/);
  assert.match(h, /<div class="m3-card-title">Appearance<\/div>/);
  assert.match(h, /<input type="range" id="hfx-s" min="0" max="100" step="1" value="0"/);
  assert.match(h, /<output id="hfx-sv" for="hfx-s">Off<\/output>/);
  assert.equal((h.match(/data-hfx-dir="/g) || []).length, 5);
  assert.equal((h.match(/data-hfx-col="/g) || []).length, 6);
  assert.match(h, /id="hfx-pv"/);
  assert.match(h, /id="hfx-reset" data-hfx-reset="1"/);
  assert.match(h, /id="hfx-st"/);
  assert.match(h, /data-hfx-dir="left" aria-pressed="true"/);
  assert.match(h, /data-hfx-col="orange" aria-pressed="true"/);
  assert.equal((h.match(/data-hfx-dir="[^"]+" aria-pressed="true"/g) || []).length, 1);
  assert.equal((h.match(/data-hfx-col="[^"]+" aria-pressed="true"/g) || []).length, 1);
  const d = makeEnv({}).sandbox.window.__mmHoverFxSettingsHtml();
  assert.match(d, /value="55"/);
  assert.match(d, /data-hfx-dir="bottom" aria-pressed="true"/);
  assert.match(d, /data-hfx-col="theme" aria-pressed="true"/);
});

test('script: the slider changes the strength, 0 turns it off, and the value is kept in range', () => {
  const env = makeEnv({});
  const c = mkCard();
  slide(env, c, 0);
  assert.equal(env.cls.has('mm-fx-off'), true);
  assert.equal(env.store.get('mm.hfx.s'), '0');
  assert.equal(env.store.get('mm.hoverfx'), '0');
  assert.equal(c.out.textContent, 'Off');
  assert.equal(c.st.textContent, 'Saved');
  assert.equal(c.st.className, 'lg-st good');
  slide(env, c, 70);
  assert.equal(env.cls.has('mm-fx-off'), false);
  assert.equal(env.store.get('mm.hfx.s'), '70');
  assert.equal(env.store.get('mm.hoverfx'), '1');
  assert.equal(env.styles.get('--hfx-s'), '70');
  assert.equal(c.out.textContent, '70');
  assert.equal(c.slider.aria['aria-valuetext'], '70');
  slide(env, c, 150);
  assert.equal(stateOf(env).s, 100);
  slide(env, c, -5);
  assert.equal(stateOf(env).s, 0);
  slide(env, c, 40);
  slide(env, c, 'x');
  assert.equal(stateOf(env).s, 40, 'a non-number must be ignored');
});

test('script: every direction preset applies, saves and highlights only itself', () => {
  for (const d of ['bottom', 'top', 'left', 'right', 'all']) {
    const env = makeEnv({});
    const c = mkCard();
    clickBtn(env, pick(c, 'dir', d));
    assert.equal(env.attrs.get('data-hfx-dir'), d);
    assert.equal(env.store.get('mm.hfx.dir'), d);
    assert.equal(stateOf(env).dir, d);
    assert.deepEqual(c.dirBtns.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-hfx-dir')), [d]);
    assert.equal(c.st.textContent, 'Saved');
  }
});

test('script: every color preset applies, saves and highlights only itself', () => {
  for (const col of ['theme', 'blue', 'green', 'purple', 'orange', 'white']) {
    const env = makeEnv({});
    const c = mkCard();
    clickBtn(env, pick(c, 'col', col));
    assert.equal(env.attrs.get('data-hfx-col'), col);
    assert.equal(env.store.get('mm.hfx.col'), col);
    assert.equal(stateOf(env).col, col);
    assert.deepEqual(c.colBtns.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-hfx-col')), [col]);
  }
});

test('script: Reset to default restores exactly the original look and forgets the saved choices', () => {
  const env = makeEnv({});
  const c = mkCard();
  slide(env, c, 90);
  clickBtn(env, pick(c, 'dir', 'all'));
  clickBtn(env, pick(c, 'col', 'white'));
  clickBtn(env, c.resetBtn);
  assert.deepEqual(stateOf(env), { s: 55, dir: 'bottom', col: 'theme', acc: 'blue', tile: 'default', out: 'default' });
  assert.equal(env.cls.has('mm-fx-off'), false);
  assert.equal(env.styles.get('--hfx-s'), '55');
  assert.equal(env.attrs.get('data-hfx-dir'), 'bottom');
  assert.equal(env.attrs.get('data-hfx-col'), 'theme');
  for (const k of ['mm.hfx.s', 'mm.hfx.dir', 'mm.hfx.col', 'mm.hoverfx']) assert.equal(env.store.has(k), false, k + ' should be forgotten');
  assert.equal(c.slider.value, '55');
  assert.equal(c.out.textContent, '55');
  assert.equal(c.st.textContent, 'Reset to default');
  assert.equal(pick(c, 'dir', 'bottom').getAttribute('aria-pressed'), 'true');
  assert.equal(pick(c, 'col', 'theme').getAttribute('aria-pressed'), 'true');
  // reset also works from the Off state
  slide(env, c, 0);
  assert.equal(env.cls.has('mm-fx-off'), true);
  clickBtn(env, c.resetBtn);
  assert.equal(env.cls.has('mm-fx-off'), false);
  // and a reload after Reset starts from the defaults
  assert.deepEqual(stateOf(makeEnv(Object.fromEntries(env.store))), { s: 55, dir: 'bottom', col: 'theme', acc: 'blue', tile: 'default', out: 'default' });
});

test('script: choices survive a reload (including strength 0)', () => {
  const env = makeEnv({});
  const c = mkCard();
  slide(env, c, 35);
  clickBtn(env, pick(c, 'dir', 'top'));
  clickBtn(env, pick(c, 'col', 'green'));
  const env2 = makeEnv(Object.fromEntries(env.store));
  assert.deepEqual(stateOf(env2), { s: 35, dir: 'top', col: 'green', acc: 'blue', tile: 'default', out: 'default' });
  assert.equal(env2.styles.get('--hfx-s'), '35');
  assert.equal(env2.attrs.get('data-hfx-dir'), 'top');
  assert.equal(env2.attrs.get('data-hfx-col'), 'green');
  assert.equal(env2.cls.has('mm-fx-off'), false);
  slide(env2, c, 0);
  const env3 = makeEnv(Object.fromEntries(env2.store));
  assert.equal(env3.cls.has('mm-fx-off'), true);
  assert.deepEqual(stateOf(env3), { s: 0, dir: 'top', col: 'green', acc: 'blue', tile: 'default', out: 'default' });
});

test('script: clicks and inputs elsewhere are ignored without throwing', () => {
  const env = makeEnv({});
  const clickH = handler(env, 'click');
  const inputH = handler(env, 'input');
  assert.doesNotThrow(() => {
    clickH({ target: { closest: () => null } });
    clickH({ target: null });
    clickH({});
    inputH({ target: { id: 'other' } });
    inputH({ target: null });
    inputH({});
  });
  assert.deepEqual(stateOf(env), { s: 55, dir: 'bottom', col: 'theme', acc: 'blue', tile: 'default', out: 'default' });
});

// ---- app accent color (the script part; the colors themselves are checked in accent-colors.test.mjs) ----
test('script: the accent defaults to blue (the original) and is set on <html>', () => {
  const env = makeEnv({});
  assert.equal(stateOf(env).acc, 'blue');
  assert.equal(env.attrs.get('data-accent'), 'blue');
  assert.equal(env.sandbox.redraws, 0, 'nothing should be redrawn just by loading');
});

test('script: a saved accent is loaded, garbage falls back to blue', () => {
  for (const a of ['blue', 'green', 'purple', 'orange', 'rose', 'teal']) {
    const env = makeEnv({ 'mm.hfx.acc': a });
    assert.equal(stateOf(env).acc, a);
    assert.equal(env.attrs.get('data-accent'), a);
  }
  for (const bad of ['pink', '', 'GREEN', 'green ', '<b>']) assert.equal(stateOf(makeEnv({ 'mm.hfx.acc': bad })).acc, 'blue', JSON.stringify(bad));
});

test('script: the card has one accent chip per preset with only the current one pressed', () => {
  const h = makeEnv({ 'mm.hfx.acc': 'rose' }).sandbox.window.__mmHoverFxSettingsHtml();
  assert.equal((h.match(/data-hfx-acc="/g) || []).length, 6);
  assert.match(h, /data-hfx-acc="rose" aria-pressed="true"/);
  assert.equal((h.match(/data-hfx-acc="[^"]+" aria-pressed="true"/g) || []).length, 1);
  assert.match(h, /App accent color/);
  assert.match(makeEnv({}).sandbox.window.__mmHoverFxSettingsHtml(), /data-hfx-acc="blue" aria-pressed="true"/);
});

test('script: every accent preset applies, saves, highlights only itself and redraws the charts', () => {
  for (const a of ['blue', 'green', 'purple', 'orange', 'rose', 'teal']) {
    const env = makeEnv({});
    const c = mkCard();
    clickBtn(env, pick(c, 'acc', a));
    assert.equal(env.attrs.get('data-accent'), a);
    assert.equal(env.store.get('mm.hfx.acc'), a);
    assert.equal(stateOf(env).acc, a);
    assert.deepEqual(c.accBtns.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-hfx-acc')), [a]);
    assert.equal(c.st.textContent, 'Saved');
    assert.equal(env.sandbox.redraws, 1, 'the charts read their colors when drawn, so they must be redrawn');
  }
});

test('script: glow changes never trigger a redraw, accent changes always do', () => {
  const env = makeEnv({});
  const c = mkCard();
  slide(env, c, 80);
  clickBtn(env, pick(c, 'dir', 'top'));
  clickBtn(env, pick(c, 'col', 'green'));
  assert.equal(env.sandbox.redraws, 0);
  clickBtn(env, pick(c, 'acc', 'teal'));
  assert.equal(env.sandbox.redraws, 1);
});

test('script: Reset brings back blue, forgets the accent, and redraws only when the accent changed', () => {
  const env = makeEnv({});
  const c = mkCard();
  clickBtn(env, c.resetBtn);
  assert.equal(env.sandbox.redraws, 0, 'Reset with the original accent needs no redraw');
  clickBtn(env, pick(c, 'acc', 'purple'));
  slide(env, c, 90);
  assert.equal(env.sandbox.redraws, 1);
  clickBtn(env, c.resetBtn);
  assert.equal(stateOf(env).acc, 'blue');
  assert.equal(env.attrs.get('data-accent'), 'blue');
  assert.equal(env.store.has('mm.hfx.acc'), false);
  assert.equal(pick(c, 'acc', 'blue').getAttribute('aria-pressed'), 'true');
  assert.equal(env.sandbox.redraws, 2);
  assert.equal(stateOf(makeEnv(Object.fromEntries(env.store))).acc, 'blue');
});

test('script: the accent survives a reload together with the glow choices', () => {
  const env = makeEnv({});
  const c = mkCard();
  clickBtn(env, pick(c, 'acc', 'orange'));
  slide(env, c, 20);
  clickBtn(env, pick(c, 'dir', 'left'));
  const env2 = makeEnv(Object.fromEntries(env.store));
  assert.deepEqual(stateOf(env2), { s: 20, dir: 'left', col: 'theme', acc: 'orange', tile: 'default', out: 'default' });
  assert.equal(env2.attrs.get('data-accent'), 'orange');
});

test('script: blocked storage with the accent never throws', () => {
  const env = makeEnv(null, true);
  const c = mkCard();
  assert.doesNotThrow(() => { clickBtn(env, pick(c, 'acc', 'green')); clickBtn(env, c.resetBtn); });
  assert.equal(stateOf(env).acc, 'blue');
});

test('script: a page without render() (or one that throws) never breaks the choice', () => {
  const env = makeEnv({});
  const c = mkCard();
  env.sandbox.render = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => clickBtn(env, pick(c, 'acc', 'green')));
  assert.equal(stateOf(env).acc, 'green');
  delete env.sandbox.render;
  assert.doesNotThrow(() => clickBtn(env, pick(c, 'acc', 'rose')));
  assert.equal(stateOf(env).acc, 'rose');
});

// ---- tile color and outline color (the script part; the colors themselves are checked in tile-outline-themes.test.mjs) ----
// (Drafted by Gemini, reviewed and corrected by Claude.)
const TILES_ALL = ['default', 'cream', 'mint', 'lavender', 'sky', 'graphite'];
const OUTS_ALL = ['default', 'soft', 'strong', 'accent'];
const ORIGINAL = { s: 55, dir: 'bottom', col: 'theme', acc: 'blue', tile: 'default', out: 'default' };

test('script: tile and outline default to the original and nothing is redrawn at load', () => {
  const env = makeEnv({});
  assert.equal(env.attrs.get('data-tile'), 'default');
  assert.equal(env.attrs.get('data-outline'), 'default');
  assert.equal(env.sandbox.redraws, 0);
  assert.deepEqual(stateOf(env), ORIGINAL);
});

test('script: a saved tile and outline are loaded, garbage falls back to the original', () => {
  const saved = makeEnv({ 'mm.hfx.tile': 'mint', 'mm.hfx.out': 'strong' });
  assert.equal(saved.attrs.get('data-tile'), 'mint');
  assert.equal(saved.attrs.get('data-outline'), 'strong');
  assert.deepEqual(stateOf(saved), { ...ORIGINAL, tile: 'mint', out: 'strong' });
  for (const bad of ['pink', '', 'GREEN', '<b>', 'mint ', 'accent']) {
    const env = makeEnv({ 'mm.hfx.tile': bad, 'mm.hfx.out': bad });
    // 'accent' is a valid outline but not a valid tile, and 'mint ' has a space: each key is checked against its own list
    assert.equal(stateOf(env).tile, 'default', 'tile ' + JSON.stringify(bad));
    assert.equal(stateOf(env).out, bad === 'accent' ? 'accent' : 'default', 'outline ' + JSON.stringify(bad));
  }
});

test('script: the card has 6 tile chips and 4 outline chips with only the current ones pressed', () => {
  const h = makeEnv({ 'mm.hfx.tile': 'lavender', 'mm.hfx.out': 'soft' }).sandbox.window.__mmHoverFxSettingsHtml();
  assert.match(h, /Tile color/);
  assert.match(h, /Outline color/);
  assert.equal((h.match(/data-hfx-tile="/g) || []).length, 6);
  assert.equal((h.match(/data-hfx-out="/g) || []).length, 4);
  assert.match(h, /data-hfx-tile="lavender" aria-pressed="true"/);
  assert.match(h, /data-hfx-out="soft" aria-pressed="true"/);
  assert.equal((h.match(/data-hfx-tile="[^"]+" aria-pressed="true"/g) || []).length, 1);
  assert.equal((h.match(/data-hfx-out="[^"]+" aria-pressed="true"/g) || []).length, 1);
  const d = makeEnv({}).sandbox.window.__mmHoverFxSettingsHtml();
  assert.match(d, /data-hfx-tile="default" aria-pressed="true"/);
  assert.match(d, /data-hfx-out="default" aria-pressed="true"/);
});

test('script: every tile preset applies, saves, highlights only itself and redraws once', () => {
  for (const t of TILES_ALL) {
    const env = makeEnv({});
    const c = mkCard();
    const btn = pick(c, 'tile', t);
    clickBtn(env, btn);
    assert.equal(env.attrs.get('data-tile'), t);
    assert.equal(env.store.get('mm.hfx.tile'), t);
    assert.equal(stateOf(env).tile, t);
    assert.equal(env.sandbox.redraws, 1);
    assert.equal(c.st.textContent, 'Saved');
    assert.deepEqual(c.tileBtns.filter((b) => b.getAttribute('aria-pressed') === 'true'), [btn]);
  }
});

test('script: every outline preset applies, saves, highlights only itself and redraws once', () => {
  for (const o of OUTS_ALL) {
    const env = makeEnv({});
    const c = mkCard();
    const btn = pick(c, 'out', o);
    clickBtn(env, btn);
    assert.equal(env.attrs.get('data-outline'), o);
    assert.equal(env.store.get('mm.hfx.out'), o);
    assert.equal(stateOf(env).out, o);
    assert.equal(env.sandbox.redraws, 1);
    assert.equal(c.st.textContent, 'Saved');
    assert.deepEqual(c.outBtns.filter((b) => b.getAttribute('aria-pressed') === 'true'), [btn]);
  }
});

test('script: glow changes never redraw, accent / tile / outline changes always do', () => {
  const env = makeEnv({});
  const c = mkCard();
  slide(env, c, 80);
  clickBtn(env, pick(c, 'dir', 'right'));
  clickBtn(env, pick(c, 'col', 'orange'));
  assert.equal(env.sandbox.redraws, 0);
  clickBtn(env, pick(c, 'acc', 'teal'));
  assert.equal(env.sandbox.redraws, 1);
  clickBtn(env, pick(c, 'tile', 'sky'));
  assert.equal(env.sandbox.redraws, 2);
  clickBtn(env, pick(c, 'out', 'accent'));
  assert.equal(env.sandbox.redraws, 3);
});

test('script: Reset redraws once if the tile or outline changed, forgets every key, and does not redraw when nothing changed', () => {
  const env = makeEnv({});
  const c = mkCard();
  clickBtn(env, pick(c, 'tile', 'graphite'));
  clickBtn(env, pick(c, 'out', 'strong'));
  const before = env.sandbox.redraws;
  clickBtn(env, c.resetBtn);
  assert.equal(env.sandbox.redraws, before + 1);
  assert.deepEqual(stateOf(env), ORIGINAL);
  assert.equal(env.attrs.get('data-tile'), 'default');
  assert.equal(env.attrs.get('data-outline'), 'default');
  assert.equal(env.store.size, 0, 'every saved key should be forgotten: ' + [...env.store.keys()]);
  assert.equal(pick(c, 'tile', 'default').getAttribute('aria-pressed'), 'true');
  assert.equal(pick(c, 'out', 'default').getAttribute('aria-pressed'), 'true');
  const quiet = makeEnv({});
  clickBtn(quiet, mkCard().resetBtn);
  assert.equal(quiet.sandbox.redraws, 0);
});

test('script: tile and outline survive a reload together with the accent and the glow', () => {
  const env = makeEnv({});
  const c = mkCard();
  slide(env, c, 40);
  clickBtn(env, pick(c, 'dir', 'left'));
  clickBtn(env, pick(c, 'col', 'purple'));
  clickBtn(env, pick(c, 'acc', 'rose'));
  clickBtn(env, pick(c, 'tile', 'cream'));
  clickBtn(env, pick(c, 'out', 'soft'));
  const env2 = makeEnv(Object.fromEntries(env.store));
  assert.deepEqual(stateOf(env2), { s: 40, dir: 'left', col: 'purple', acc: 'rose', tile: 'cream', out: 'soft' });
  assert.equal(env2.attrs.get('data-tile'), 'cream');
  assert.equal(env2.attrs.get('data-outline'), 'soft');
  assert.equal(env2.attrs.get('data-accent'), 'rose');
});

test('script: blocked storage never throws for tile and outline clicks or Reset', () => {
  const env = makeEnv(null, true);
  const c = mkCard();
  assert.doesNotThrow(() => { clickBtn(env, pick(c, 'tile', 'mint')); clickBtn(env, pick(c, 'out', 'strong')); });
  assert.equal(stateOf(env).tile, 'mint');
  assert.equal(stateOf(env).out, 'strong');
  assert.doesNotThrow(() => clickBtn(env, c.resetBtn));
  assert.deepEqual(stateOf(env), ORIGINAL);
});

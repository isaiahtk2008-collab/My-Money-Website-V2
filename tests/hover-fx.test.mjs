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
      return [];
    },
  };
  return { card, slider, out, st, dirBtns, colBtns, resetBtn };
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

const pick = (c, kind, v) => c[kind === 'dir' ? 'dirBtns' : 'colBtns'].find((b) => b.getAttribute('data-hfx-' + kind) === v);

test('script: defaults are strength 55, bottom, match theme, and the effect is on', () => {
  const env = makeEnv({});
  assert.equal(env.cls.has('mm-fx-off'), false);
  assert.deepEqual(stateOf(env), { s: 55, dir: 'bottom', col: 'theme' });
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
  assert.deepEqual(stateOf(env), { s: 55, dir: 'bottom', col: 'theme' });
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
  assert.deepEqual(stateOf(env), { s: 55, dir: 'bottom', col: 'theme' });
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
  assert.deepEqual(stateOf(makeEnv(Object.fromEntries(env.store))), { s: 55, dir: 'bottom', col: 'theme' });
});

test('script: choices survive a reload (including strength 0)', () => {
  const env = makeEnv({});
  const c = mkCard();
  slide(env, c, 35);
  clickBtn(env, pick(c, 'dir', 'top'));
  clickBtn(env, pick(c, 'col', 'green'));
  const env2 = makeEnv(Object.fromEntries(env.store));
  assert.deepEqual(stateOf(env2), { s: 35, dir: 'top', col: 'green' });
  assert.equal(env2.styles.get('--hfx-s'), '35');
  assert.equal(env2.attrs.get('data-hfx-dir'), 'top');
  assert.equal(env2.attrs.get('data-hfx-col'), 'green');
  assert.equal(env2.cls.has('mm-fx-off'), false);
  slide(env2, c, 0);
  const env3 = makeEnv(Object.fromEntries(env2.store));
  assert.equal(env3.cls.has('mm-fx-off'), true);
  assert.deepEqual(stateOf(env3), { s: 0, dir: 'top', col: 'green' });
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
  assert.deepEqual(stateOf(env), { s: 55, dir: 'bottom', col: 'theme' });
});

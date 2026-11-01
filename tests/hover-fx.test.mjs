// Static checks for the hover effects (enlarge + under-glow) and its on/off switch. Run: node --test tests/hover-fx.test.mjs
// Guards the safety rules: every rule sits behind the off switch, only on real hover pointers, and never touches the modal
// backdrop, SVG chart slices, text boxes (no resize) or table cells (no transform). Never touches the sheet.
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

function makeEnv(stored, throwing) {
  const cls = new Set();
  const handlers = [];
  const store = new Map(stored ? [['mm.hoverfx', stored]] : []);
  const sandbox = {
    document: {
      documentElement: { classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) } },
      addEventListener: (t, f) => handlers.push([t, f]),
    },
    localStorage: throwing ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(jsMatch[1], sandbox);
  return { sandbox, cls, handlers, store };
}

test('script: default is on, saved "0" is off', () => {
  assert.equal(makeEnv(null).cls.has('mm-fx-off'), false);
  assert.equal(makeEnv('1').cls.has('mm-fx-off'), false);
  assert.equal(makeEnv('0').cls.has('mm-fx-off'), true);
});

test('script: blocked storage never throws and stays on', () => {
  const env = makeEnv(null, true);
  assert.equal(env.cls.has('mm-fx-off'), false);
  assert.match(env.sandbox.window.__mmHoverFxSettingsHtml(), /data-hfx="1" aria-pressed="true"/);
});

test('script: settings card markup reflects the saved state', () => {
  const on = makeEnv(null).sandbox.window.__mmHoverFxSettingsHtml();
  assert.match(on, /id="hfx-card"/);
  assert.match(on, /data-hfx="1" aria-pressed="true">On</);
  assert.match(on, /data-hfx="0" aria-pressed="false">Off</);
  const off = makeEnv('0').sandbox.window.__mmHoverFxSettingsHtml();
  assert.match(off, /data-hfx="1" aria-pressed="false">On</);
  assert.match(off, /data-hfx="0" aria-pressed="true">Off</);
});

test('script: clicking Off then On flips the class, saves, and updates the buttons', () => {
  const env = makeEnv(null);
  const [, handler] = env.handlers.find(h => h[0] === 'click');
  const mk = v => { const b = { v, pressed: null, getAttribute: n => (n === 'data-hfx' ? v : null), setAttribute(n, x) { if (n === 'aria-pressed') b.pressed = x; } }; return b; };
  const bOn = mk('1'), bOff = mk('0'), st = { className: '', textContent: '' };
  const card = { querySelectorAll: () => [bOn, bOff], querySelector: () => st };
  for (const b of [bOn, bOff]) b.closest = () => card;
  const click = b => handler({ target: { closest: () => b } });
  click(bOff);
  assert.equal(env.cls.has('mm-fx-off'), true);
  assert.equal(env.store.get('mm.hoverfx'), '0');
  assert.equal(bOff.pressed, 'true'); assert.equal(bOn.pressed, 'false');
  assert.equal(st.textContent, 'Saved'); assert.equal(st.className, 'lg-st good');
  click(bOn);
  assert.equal(env.cls.has('mm-fx-off'), false);
  assert.equal(env.store.get('mm.hoverfx'), '1');
  assert.equal(bOn.pressed, 'true'); assert.equal(bOff.pressed, 'false');
  // clicks elsewhere are ignored
  assert.doesNotThrow(() => handler({ target: { closest: () => null } }));
  assert.doesNotThrow(() => handler({ target: null }));
});

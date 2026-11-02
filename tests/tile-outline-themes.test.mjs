// Static checks for the tile color and outline color presets (Security & Settings > Appearance). Run: node --test tests/tile-outline-themes.test.mjs
// Every tile color has a light and a dark version. Normal text and EVERY accent color must stay readable (>= 4.5:1) on every tile color
// (the original blue keeps its original 4.0 on gray tiles), and the Strong and Match accent outlines must be clearly visible.
// All original colors are read from the page itself, so the test notices if they drift. Never touches the sheet.
// (Drafted by Gemini, reviewed and wired up by Claude.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function hexToRgb(hex) {
  const num = parseInt(hex.replace('#', ''), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
function relLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const l1 = relLuminance(a), l2 = relLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
// pctA of color A plus the rest of color B, per sRGB channel (what color-mix(in srgb, A pct, B) does)
function mixSrgb(hexA, hexB, pctA) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return '#' + a.map((x, i) => Math.round(x * pctA + b[i] * (1 - pctA)).toString(16).padStart(2, '0')).join('');
}
// the variables inside the innermost { ... } of a rule (the @media rules have nested braces)
function parseRuleVars(line) {
  const m = line.match(/\{([^{}]+)\}/);
  const vars = {};
  if (!m) return vars;
  for (const part of m[1].split(';')) {
    const i = part.indexOf(':');
    if (i > 0) vars[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return vars;
}

// ---- the original colors, read from the page ----
const lightBlock = html.match(/:root\{\n  --bg:[^}]+\}/);
const darkBlock = html.match(/:root\[data-theme="dark"\]\{\n  --bg:[^}]+\}/);
const darkOverride = html.match(/:root\[data-theme="dark"\]\{--muted:[^}]+\}/);   // a later rule that changes the dark muted text and line colors
const lightOverride = html.match(/^:root\{--muted:[^}]+\}/m);   // a later rule that darkens the light muted text and the outline color
const origLight = lightBlock ? parseRuleVars(lightBlock[0]) : {};
if (lightOverride) Object.assign(origLight, parseRuleVars(lightOverride[0]));
const origDark = darkBlock ? parseRuleVars(darkBlock[0]) : {};
if (darkOverride) Object.assign(origDark, parseRuleVars(darkOverride[0]));
const ORIG = { light: origLight, dark: origDark };

// ---- accent colors: ACCENTS[name][mode] = hex ----
const accentCss = (html.match(/<style id="mm-accent">([\s\S]*?)<\/style>/) || [, ''])[1];
const ACCENTS = { blue: { light: origLight['--accent'], dark: origDark['--accent'] } };
const ACCENT_INK = { blue: { light: origLight['--accent-ink'], dark: origDark['--accent-ink'] } };
const ACCENT_SOFT = { blue: { light: origLight['--accent-soft'], dark: origDark['--accent-soft'] } };
for (const line of accentCss.split('\n')) {
  const light = line.match(/^:root\[data-accent="([^"]+)"\]/);
  const dark = line.match(/^:root\[data-theme="dark"\]\[data-accent="([^"]+)"\]/);
  const name = (light || dark || [])[1];
  if (!name) continue;
  const mode = light ? 'light' : 'dark';
  const v = parseRuleVars(line);
  (ACCENTS[name] = ACCENTS[name] || {})[mode] = v['--accent'];
  (ACCENT_INK[name] = ACCENT_INK[name] || {})[mode] = v['--accent-ink'];
  (ACCENT_SOFT[name] = ACCENT_SOFT[name] || {})[mode] = v['--accent-soft'];
}

// ---- tile and outline presets ----
const tilesStart = html.indexOf('<style id="mm-tiles">');
const tilesText = tilesStart === -1 ? '' : html.substring(tilesStart, html.indexOf('</style>', tilesStart));
const tileLines = tilesText.split('\n').map((l) => l.trim()).filter(Boolean);
const TILE_NAMES = ['cream', 'mint', 'lavender', 'sky', 'graphite'];
const OUT_NAMES = ['soft', 'strong'];

const TILES = { default: { light: { surface: origLight['--surface'], surface2: origLight['--surface2'] }, dark: { surface: origDark['--surface'], surface2: origDark['--surface2'] } } };
const OUT = { default: { light: origLight['--line'], dark: origDark['--line'] } };
for (const n of TILE_NAMES) TILES[n] = { light: {}, dark: {} };
for (const n of OUT_NAMES) OUT[n] = { light: null, dark: null };
const rule = (kind, name, which) => tileLines.find((l) => {
  const sel = '[data-' + kind + '="' + name + '"]';
  if (!l.includes(sel)) return false;
  if (which === 'light') return l.startsWith(':root' + sel);
  if (which === 'auto') return l.startsWith('@media (prefers-color-scheme:dark){:root:not([data-theme="light"])' + sel);
  return l.startsWith(':root[data-theme="dark"]' + sel);
});
for (const n of TILE_NAMES) {
  const l = rule('tile', n, 'light'), d = rule('tile', n, 'dark');
  if (l) TILES[n].light = { surface: parseRuleVars(l)['--surface'], surface2: parseRuleVars(l)['--surface2'] };
  if (d) TILES[n].dark = { surface: parseRuleVars(d)['--surface'], surface2: parseRuleVars(d)['--surface2'] };
}
for (const n of OUT_NAMES) {
  const l = rule('outline', n, 'light'), d = rule('outline', n, 'dark');
  if (l) OUT[n].light = parseRuleVars(l)['--line'];
  if (d) OUT[n].dark = parseRuleVars(d)['--line'];
}
const MODES = ['light', 'dark'];
const HEX6 = /^#[0-9a-fA-F]{6}$/;

test('tile style block exists exactly once', () => {
  assert.equal((html.match(/<style id="mm-tiles">/g) || []).length, 1);
});

test('every tile preset and the soft and strong outlines have a light, an automatic-dark and a forced-dark rule', () => {
  for (const n of TILE_NAMES) {
    for (const which of ['light', 'auto', 'dark']) {
      const r = rule('tile', n, which);
      assert.ok(r, 'tile ' + n + ': ' + which + ' rule missing');
      const v = parseRuleVars(r);
      assert.match(v['--surface'] || '', HEX6, n + ' ' + which + ' --surface');
      assert.match(v['--surface2'] || '', HEX6, n + ' ' + which + ' --surface2');
    }
  }
  for (const n of OUT_NAMES) {
    for (const which of ['light', 'auto', 'dark']) {
      const r = rule('outline', n, which);
      assert.ok(r, 'outline ' + n + ': ' + which + ' rule missing');
      assert.match(parseRuleVars(r)['--line'] || '', HEX6, n + ' ' + which + ' --line');
    }
  }
  const acc = tileLines.filter((l) => l.includes('[data-outline="accent"]'));
  assert.equal(acc.length, 1, 'the Match accent outline has exactly one rule');
  assert.ok(acc[0].includes('color-mix(in srgb,var(--accent) 70%,var(--surface))'));
});

test('the automatic-dark and forced-dark rules carry identical colors', () => {
  for (const n of TILE_NAMES) assert.deepEqual({ ...parseRuleVars(rule('tile', n, 'auto')) }, { ...parseRuleVars(rule('tile', n, 'dark')) }, 'tile ' + n);
  for (const n of OUT_NAMES) assert.deepEqual({ ...parseRuleVars(rule('outline', n, 'auto')) }, { ...parseRuleVars(rule('outline', n, 'dark')) }, 'outline ' + n);
});

test('default has no rule, and the script lists exactly these presets', () => {
  assert.ok(!tilesText.includes('data-tile="default"'));
  assert.ok(!tilesText.includes('data-outline="default"'));
  const tiles = html.match(/var VALID_TILES = (\[.*?\]);/), outs = html.match(/var VALID_OUTS = (\[.*?\]);/);
  assert.ok(tiles && outs, 'preset lists not found in the script');
  assert.deepEqual(JSON.parse(tiles[1].replace(/'/g, '"')), ['default', 'cream', 'mint', 'lavender', 'sky', 'graphite']);
  assert.deepEqual(JSON.parse(outs[1].replace(/'/g, '"')), ['default', 'soft', 'strong', 'accent']);
});

test('the original tile and outline colors are unchanged', () => {
  assert.deepEqual([origLight['--surface'], origLight['--surface2'], origLight['--line']], ['#ffffff', '#eceff4', '#cdd3de']);
  assert.deepEqual([origDark['--surface'], origDark['--surface2'], origDark['--line']], ['#161a21', '#1f242d', '#363e4c']);
});

test('normal text and muted text are readable on every tile color', () => {
  for (const mode of MODES) for (const [name, t] of Object.entries(TILES)) for (const key of ['surface', 'surface2']) {
    const bg = t[mode][key];
    const ci = contrast(ORIG[mode]['--ink'], bg), cm = contrast(ORIG[mode]['--muted'], bg);
    assert.ok(ci >= 4.5, name + ' ' + mode + ' ' + key + ': text ' + ci.toFixed(2) + ':1');
    assert.ok(cm >= 4.5, name + ' ' + mode + ' ' + key + ': muted text ' + cm.toFixed(2) + ':1');
  }
});

test('every accent color is readable on every tile color', () => {
  for (const [tn, t] of Object.entries(TILES)) for (const [an, a] of Object.entries(ACCENTS)) for (const mode of MODES) {
    const cs = contrast(a[mode], t[mode].surface), c2 = contrast(a[mode], t[mode].surface2);
    const min2 = an === 'blue' && mode === 'light' ? 4.0 : 4.5;   // the original look on gray tiles is 4.02:1: keep it, never make it worse
    assert.ok(cs >= 4.5, tn + ' tile, ' + an + ' accent, ' + mode + ', on cards: ' + cs.toFixed(2) + ':1');
    assert.ok(c2 >= min2, tn + ' tile, ' + an + ' accent, ' + mode + ', on gray tiles: ' + c2.toFixed(2) + ':1');
  }
});

test('text on the accent and normal text on the accent tint do not depend on the tile', () => {
  for (const an of Object.keys(ACCENTS)) for (const mode of MODES) {
    const a = contrast(ACCENT_INK[an][mode], ACCENTS[an][mode]);
    const s = contrast(ORIG[mode]['--ink'], ACCENT_SOFT[an][mode]);
    assert.ok(a >= 4.5, an + ' ' + mode + ': text on accent ' + a.toFixed(2) + ':1');
    assert.ok(s >= 4.5, an + ' ' + mode + ': text on tint ' + s.toFixed(2) + ':1');
  }
});

test('tile colors are visibly different from each other', () => {
  for (const mode of MODES) {
    assert.equal(new Set(Object.values(TILES).map((t) => t[mode].surface.toLowerCase())).size, 6, mode + ' card colors must all differ');
    assert.equal(new Set(Object.values(TILES).map((t) => t[mode].surface2.toLowerCase())).size, 6, mode + ' gray tile colors must all differ');
  }
});

test('dark tiles are dark and light tiles are light', () => {
  for (const [n, t] of Object.entries(TILES)) {
    assert.ok(relLuminance(t.light.surface) >= 0.9, n + ' light card is too dark');
    assert.ok(relLuminance(t.dark.surface) <= 0.05, n + ' dark card is too light');
  }
});

test('strong outlines are clearly visible (>= 3:1) on every tile color', () => {
  for (const mode of MODES) for (const [n, t] of Object.entries(TILES)) for (const key of ['surface', 'surface2']) {
    const c = contrast(OUT.strong[mode], t[mode][key]);
    assert.ok(c >= 3, n + ' ' + mode + ' ' + key + ': strong outline ' + c.toFixed(2) + ':1');
  }
});

test('soft outlines are subtler than the original but still visible (> 1.05:1)', () => {
  for (const mode of MODES) for (const [n, t] of Object.entries(TILES)) {
    const soft = contrast(OUT.soft[mode], t[mode].surface), orig = contrast(OUT.default[mode], t[mode].surface);
    assert.ok(soft > 1.05, n + ' ' + mode + ': soft outline ' + soft.toFixed(2) + ':1 is invisible');
    assert.ok(soft < orig, n + ' ' + mode + ': soft ' + soft.toFixed(2) + ' should be subtler than the original ' + orig.toFixed(2));
  }
});

test('the Match accent outline is clearly visible (>= 2:1 light, >= 3:1 dark) for every accent on every tile', () => {
  for (const [tn, t] of Object.entries(TILES)) for (const [an, a] of Object.entries(ACCENTS)) for (const mode of MODES) for (const key of ['surface', 'surface2']) {
    const bg = t[mode][key];
    const need = mode === 'light' ? 2 : 3;
    const c = contrast(mixSrgb(a[mode], t[mode].surface, 0.7), bg);
    assert.ok(c >= need, tn + ' tile, ' + an + ' accent, ' + mode + ' ' + key + ': accent outline ' + c.toFixed(2) + ':1');
  }
});

test('dark rules are more specific than light rules so dark wins', () => {
  for (const [kind, names] of [['tile', TILE_NAMES], ['outline', OUT_NAMES]]) for (const n of names) {
    assert.ok(rule(kind, n, 'light').startsWith(':root[data-' + kind + '="' + n + '"]{'), kind + ' ' + n + ': light selector');
    assert.ok(rule(kind, n, 'auto').includes(':not([data-theme="light"])[data-' + kind + '="' + n + '"]'), kind + ' ' + n + ': automatic dark selector');
    assert.ok(rule(kind, n, 'dark').startsWith(':root[data-theme="dark"][data-' + kind + '="' + n + '"]{'), kind + ' ' + n + ': forced dark selector');
  }
});

test('the card builds one chip per tile and outline preset', () => {
  for (const s of ["{ k: 'default', t: 'Original'", "{ k: 'cream', t: 'Cream'", "{ k: 'mint', t: 'Mint'", "{ k: 'lavender', t: 'Lavender'", "{ k: 'sky', t: 'Sky'", "{ k: 'graphite', t: 'Graphite'",
    "{ k: 'soft', t: 'Soft' }", "{ k: 'strong', t: 'Strong' }", "{ k: 'accent', t: 'Match accent' }"]) assert.ok(html.includes(s), 'missing ' + s);
  assert.ok(html.includes('data-hfx-tile="') && html.includes('data-hfx-out="'));
});

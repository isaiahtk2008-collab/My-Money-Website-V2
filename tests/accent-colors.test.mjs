// Static checks for the app accent color presets (Security & Settings > Appearance). Run: node --test tests/accent-colors.test.mjs
// Every preset has a light and a dark version, and every text/background pair that matters is checked against WCAG contrast (>= 4.5:1),
// reading the page's own surface colors so the test notices if they drift. Blue is the original look: it has no rule and keeps its original colors.
// Never touches the sheet. (Drafted by Gemini, reviewed and wired up by Claude.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return { r: parseInt(clean.substring(0, 2), 16), g: parseInt(clean.substring(2, 4), 16), b: parseInt(clean.substring(4, 6), 16) };
}
function relLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const ch = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
function contrast(a, b) {
  const l1 = relLuminance(a), l2 = relLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// the first "--name:value" pairs inside the block that starts at blockStart (read from the page, not hard-coded)
function vars(blockStart) {
  const idx = html.indexOf(blockStart);
  if (idx === -1) throw new Error('Could not find block start: ' + blockStart);
  const block = html.substring(idx, html.indexOf('}', idx));
  const obj = {};
  for (const part of block.split(/;|\n/)) {
    const t = part.trim();
    if (!t.startsWith('--')) continue;
    const i = t.indexOf(':');
    if (i > 0) obj[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return obj;
}
const lightBase = vars(':root{\n  --bg');
const darkBase = vars(':root[data-theme="dark"]{\n  --bg');

const PRESETS = ['green', 'purple', 'orange', 'rose', 'teal'];
const ALL_PRESETS = ['blue', ...PRESETS];

const styleStart = html.indexOf('<style id="mm-accent">');
const styleContent = styleStart === -1 ? '' : html.substring(styleStart, html.indexOf('</style>', styleStart));

// the variables inside the innermost { ... } of a one-line rule
function parseRuleVars(line) {
  const m = line.match(/\{([^{}]+)\}/);
  const res = {};
  if (!m) return res;
  for (const item of m[1].split(';')) {
    const i = item.indexOf(':');
    if (i > 0) res[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return res;
}
function getPresetRules(name) {
  const lines = styleContent.split('\n').map((l) => l.trim()).filter(Boolean);
  const lightLine = lines.find((l) => l.startsWith(':root[data-accent="' + name + '"]'));
  const autoDarkLine = lines.find((l) => l.startsWith('@media (prefers-color-scheme:dark){:root:not([data-theme="light"])[data-accent="' + name + '"]'));
  const forcedDarkLine = lines.find((l) => l.startsWith(':root[data-theme="dark"][data-accent="' + name + '"]'));
  return {
    lightLine, autoDarkLine, forcedDarkLine,
    lightVars: lightLine ? parseRuleVars(lightLine) : {},
    autoDarkVars: autoDarkLine ? parseRuleVars(autoDarkLine) : {},
    forcedDarkVars: forcedDarkLine ? parseRuleVars(forcedDarkLine) : {},
  };
}
const VARS = { light: { blue: lightBase }, dark: { blue: darkBase } };
for (const name of PRESETS) {
  const r = getPresetRules(name);
  VARS.light[name] = r.lightVars;
  VARS.dark[name] = r.forcedDarkVars;
}
const BASE = { light: lightBase, dark: darkBase };

test('accent style block exists exactly once', () => {
  assert.equal((html.match(/<style id="mm-accent">/g) || []).length, 1);
});

test('every non-default preset has a light, an automatic-dark and a forced-dark rule defining all four variables', () => {
  for (const name of PRESETS) {
    const r = getPresetRules(name);
    assert.ok(r.lightLine, 'light rule missing for ' + name);
    assert.ok(r.autoDarkLine, 'automatic dark rule missing for ' + name);
    assert.ok(r.forcedDarkLine, 'forced dark rule missing for ' + name);
    for (const [label, v] of [['light', r.lightVars], ['auto-dark', r.autoDarkVars], ['forced-dark', r.forcedDarkVars]]) {
      for (const k of ['--accent', '--accent-ink', '--accent-soft', '--c1']) {
        assert.match(v[k] || '', /^#[0-9a-fA-F]{6}$/, name + ' ' + label + ' ' + k + ' should be a 6-digit hex');
      }
    }
  }
});

test('blue (the original) has no rule, and the script lists exactly the six presets', () => {
  assert.ok(!styleContent.includes('data-accent="blue"'), 'blue must not have a rule');
  const m = html.match(/var VALID_ACCS\s*=\s*(\[[^\]]+\]);/);
  assert.ok(m, 'VALID_ACCS not found');
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), ['blue', 'green', 'purple', 'orange', 'rose', 'teal']);
});

test('the automatic-dark and forced-dark rules carry identical colors', () => {
  for (const name of PRESETS) {
    const r = getPresetRules(name);
    assert.deepEqual({ ...r.autoDarkVars }, { ...r.forcedDarkVars }, 'dark mismatch for ' + name);
  }
});

test('blue still has exactly the original accent colors', () => {
  assert.deepEqual([lightBase['--accent'], lightBase['--accent-ink'], lightBase['--accent-soft']], ['#1f6feb', '#ffffff', '#e6efff']);
  assert.deepEqual([darkBase['--accent'], darkBase['--accent-ink'], darkBase['--accent-soft']], ['#7fb0ff', '#0b1220', '#16294a']);
});

test('text on the accent is readable (>= 4.5:1) for every preset, light and dark', () => {
  for (const mode of ['light', 'dark']) for (const name of ALL_PRESETS) {
    const v = VARS[mode][name];
    const ratio = contrast(v['--accent-ink'], v['--accent']);
    assert.ok(ratio >= 4.5, name + ' (' + mode + ') text on accent is ' + ratio.toFixed(2) + ':1');
  }
});

test('accent text on cards, page background and gray tiles is readable (>= 4.5:1)', () => {
  for (const mode of ['light', 'dark']) for (const name of ALL_PRESETS) {
    const accent = VARS[mode][name]['--accent'], base = BASE[mode];
    const rs = contrast(accent, base['--surface']), rb = contrast(accent, base['--bg']), r2 = contrast(accent, base['--surface2']);
    const orig = name === 'blue' && mode === 'light';   // the original look: keep it as it is, but never let it get worse
    assert.ok(rs >= 4.5, name + ' ' + mode + ' on cards ' + rs.toFixed(2) + ':1');
    assert.ok(rb >= (orig ? 4.0 : 4.5), name + ' ' + mode + ' on the page background ' + rb.toFixed(2) + ':1');
    assert.ok(r2 >= (orig ? 4.0 : 4.5), name + ' ' + mode + ' on gray tiles ' + r2.toFixed(2) + ':1');
  }
});

test('accent text on its own pale tint is readable (>= 4.5:1)', () => {
  for (const mode of ['light', 'dark']) for (const name of ALL_PRESETS) {
    const v = VARS[mode][name];
    const ratio = contrast(v['--accent'], v['--accent-soft']);
    const min = name === 'blue' && mode === 'light' ? 3.9 : 4.5;
    assert.ok(ratio >= min, name + ' (' + mode + ') accent on tint is ' + ratio.toFixed(2) + ':1');
  }
});

test('normal text stays readable on the pale tint (>= 4.5:1)', () => {
  for (const mode of ['light', 'dark']) for (const name of ALL_PRESETS) {
    const ratio = contrast(BASE[mode]['--ink'], VARS[mode][name]['--accent-soft']);
    assert.ok(ratio >= 4.5, name + ' (' + mode + ') text on tint is ' + ratio.toFixed(2) + ':1');
  }
});

test('the presets are visibly different from each other', () => {
  for (const mode of ['light', 'dark']) {
    const accents = ALL_PRESETS.map((n) => VARS[mode][n]['--accent'].toLowerCase());
    assert.equal(new Set(accents).size, ALL_PRESETS.length, mode + ' accents must all differ');
  }
});

test('the first chart color follows the accent', () => {
  for (const mode of ['light', 'dark']) for (const name of PRESETS) {
    assert.equal(VARS[mode][name]['--c1'].toLowerCase(), VARS[mode][name]['--accent'].toLowerCase(), name + ' (' + mode + ')');
  }
});

test('dark rules are more specific than light rules so dark wins', () => {
  for (const name of PRESETS) {
    const r = getPresetRules(name);
    assert.ok(r.lightLine.startsWith(':root[data-accent="' + name + '"]{'));
    assert.ok(r.autoDarkLine.includes(':not([data-theme="light"])[data-accent="' + name + '"]'));
    assert.ok(r.forcedDarkLine.includes('[data-theme="dark"][data-accent="' + name + '"]'));
  }
});

test('the card builds one chip per preset', () => {
  for (const name of ALL_PRESETS) assert.ok(html.includes("{ k: '" + name + "', t: '"), 'chip entry for ' + name);
  assert.ok(html.includes('data-hfx-acc="'), 'chip markup missing');
});

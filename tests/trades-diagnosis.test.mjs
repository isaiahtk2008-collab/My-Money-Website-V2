// When Trades or Pre-IPO is not loaded, the site must say WHY: script too old, or script unreachable. Otherwise the normal "add a tab" note stays.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const fnSrc = html.match(/^function trScriptDiag\(tabName\) \{[\s\S]*?\n\}\n/m);

function run(win, tab) {
  assert.ok(fnSrc, 'trScriptDiag found');
  const f = new Function('window', 'esc', fnSrc[0] + '\nreturn trScriptDiag;')(win, s => String(s));
  return f(tab);
}

test('script sent tabs but no Trades key: tells the user to update the script', () => {
  const out = run({ __mmScriptTabs: ['Expenses', 'Owed'], __mmScriptErr: '' }, 'Trades');
  assert.match(out, /needs updating/);
});

test('Pre-IPO maps to the PreIPO key', () => {
  assert.match(run({ __mmScriptTabs: ['Trades'] }, 'Pre-IPO'), /needs updating/);
  assert.equal(run({ __mmScriptTabs: ['PreIPO'] }, 'Pre-IPO'), '');
});

test('script unreachable (fallback feed): says so with the reason', () => {
  const out = run({ __mmScriptTabs: null, __mmScriptErr: 'HTTP 500' }, 'Trades');
  assert.match(out, /could not be reached/);
  assert.match(out, /HTTP 500/);
});

test('script sent the key, or nothing is known: normal setup note stays (empty diagnosis)', () => {
  assert.equal(run({ __mmScriptTabs: ['Trades'] }, 'Trades'), '');
  assert.equal(run({}, 'Trades'), '');
});

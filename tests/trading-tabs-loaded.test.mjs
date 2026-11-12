// The website must keep the Trades and Pre-IPO tabs the script returns, otherwise the Trading screens always show the "add a tab" setup note.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = html.match(/^const EXTRA_TABS=\{[^\n]*\};/m);
const loader = html.match(/^async function loadViaScript\(url,tabs\)\{[\s\S]*?\n  return out\}/m);

test('EXTRA_TABS names the Trades and Pre-IPO tabs', () => {
  assert.ok(m, 'EXTRA_TABS line found');
  const EXTRA_TABS = new Function(m[0] + '; return EXTRA_TABS;')();
  assert.equal(EXTRA_TABS.Trades, 'Trades');
  assert.equal(EXTRA_TABS.PreIPO, 'Pre-IPO');
  assert.equal(EXTRA_TABS.Owed, 'Owed');
});

test('loadViaScript keeps Trades and PreIPO (header-only tabs too) and still skips missing ones', async () => {
  assert.ok(m && loader, 'loader found');
  const tabsReply = {
    A: { sheet: 'A', headers: ['x'], rows: [] },
    Owed: { sheet: 'Owed', headers: ['Row ID'], rows: [] },
    Trades: { sheet: 'Trades', headers: ['Timestamp', 'Row ID'], rows: [] },
    PreIPO: { sheet: 'Pre-IPO', headers: ['Timestamp', 'Row ID'], rows: [] },
    SoldAccess: { sheet: 'Sold Access - Form', headers: [], rows: [], missing: true }
  };
  const fn = new Function('LS', 'fetch', 'mmAuthFail', 'let _mmFresh=false; const mmRcSave=()=>{};\n' + m[0] + '\n' + loader[0] + '\nreturn loadViaScript;')(
    { get: () => '' },
    async () => ({ ok: true, json: async () => ({ ok: true, tabs: tabsReply }) }),
    () => {}
  );
  const out = await fn('https://example.invalid/exec', { A: 'A' });
  assert.ok(out.Trades && Array.isArray(out.Trades.rows), 'Trades kept');
  assert.ok(out.PreIPO && Array.isArray(out.PreIPO.rows), 'PreIPO kept');
  assert.deepEqual(out.Trades.headers, ['Timestamp', 'Row ID']);
  assert.ok(out.Owed, 'Owed still kept');
  assert.equal(out.SoldAccess, undefined, 'a missing tab is still skipped');
});

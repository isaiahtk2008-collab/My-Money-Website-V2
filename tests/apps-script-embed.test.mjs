// Run with: node tests/apps-script-embed.test.mjs
// Proves the copy-and-paste script embedded in index.html (APPS_SCRIPT) is byte-for-byte identical to apps-script.gs,
// so copying the script from the app can never lose the edit/delete handler.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gs = fs.readFileSync(path.join(here, '..', 'apps-script.gs'), 'utf8');
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

function embedded() {
  const found = html.split('\n').filter(line => line.startsWith('const APPS_SCRIPT="'));
  assert.equal(found.length, 1, 'expected exactly one APPS_SCRIPT constant line in index.html');
  assert.ok(found[0].endsWith(';'), 'APPS_SCRIPT line does not end with ;');
  return JSON.parse(found[0].slice('const APPS_SCRIPT='.length, -1));
}

t('index.html has exactly one APPS_SCRIPT constant line and it is a valid JSON string', () => {
  assert.equal(typeof embedded(), 'string');
});

t('embedded APPS_SCRIPT is byte-for-byte identical to apps-script.gs', () => {
  assert.equal(embedded() === gs, true, 'APPS_SCRIPT in index.html is out of date, regenerate it from apps-script.gs');
});

t('embedded APPS_SCRIPT contains the edit handler', () => {
  assert.ok(embedded().includes("action === 'edit'"), 'embedded script is missing the edit handler');
});

console.log(`\n${n} checks passed`);

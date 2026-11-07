// Checks the sign-in and session code in apps-script.gs with a faked Google (UrlFetchApp) and a faked property store.
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

const code = fs.readFileSync(new URL('../apps-script.gs', import.meta.url), 'utf8')
  .replace("'PASTE-YOUR-GOOGLE-CLIENT-ID.apps.googleusercontent.com'", "'client-1.apps.googleusercontent.com'")
  .replace("'you@example.com'", "'me@example.com'");

function make({ google = {}, src = code } = {}) {
  const props = {};
  const fetches = [];
  const ctx = {
    console: { log() {} },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => [], getSpreadsheetTimeZone: () => 'UTC' }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    UrlFetchApp: { fetch: url => { fetches.push(url); const g = google.reply || { code: 200, body: google.info }; return { getResponseCode: () => g.code, getContentText: () => JSON.stringify(g.body) }; } },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      formatDate: () => ''
    }
  };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  ctx.__props = props; ctx.__fetches = fetches;
  return ctx;
}
const good = (over = {}) => ({ iss: 'https://accounts.google.com', aud: 'client-1.apps.googleusercontent.com', email: 'me@example.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3000), ...over });
const CRED = 'aaaa.bbbb.cccc';
const post = (c, b) => JSON.parse(c.doPost({ postData: { contents: JSON.stringify(b) } }).text);

test('a real sign-in gets a token, and the token opens read', () => {
  const c = make({ google: { info: good() } });
  const r = post(c, { action: 'login', credential: CRED });
  assert.equal(r.ok, true);
  assert.match(r.token, /^[0-9a-f]{64}$/);
  assert.ok(r.expires > Date.now() + 6 * 86400000);
  assert.equal(post(c, { action: 'read', secret: r.token }).ok, true);
});

test('only the hash of a token is stored, never the token', () => {
  const c = make({ google: { info: good() } });
  const { token } = post(c, { action: 'login', credential: CRED });
  assert.ok(!JSON.stringify(c.__props).includes(token));
});

test('the email check ignores case and spaces', () => {
  const c = make({ google: { info: good({ email: '  Me@Example.COM ' }) } });
  assert.equal(post(c, { action: 'login', credential: CRED }).ok, true);
});

for (const [name, over] of [
  ['someone else\'s email', { email: 'other@example.com' }],
  ['a token made for a different app', { aud: 'evil.apps.googleusercontent.com' }],
  ['an unverified email', { email_verified: 'false' }],
  ['a wrong issuer', { iss: 'https://evil.example.com' }],
  ['an expired sign-in', { exp: String(Math.floor(Date.now() / 1000) - 10) }],
  ['no expiry at all', { exp: undefined }],
  ['no email at all', { email: undefined }]
]) {
  test('login refused: ' + name, () => {
    const c = make({ google: { info: good(over) } });
    const r = post(c, { action: 'login', credential: CRED });
    assert.equal(r.ok, false); assert.equal(r.error, 'auth'); assert.equal(r.token, undefined);
    assert.equal(post(c, { action: 'read' }).error, 'auth');
  });
}

test('login refused: Google says no (HTTP 400) or sends junk', () => {
  assert.equal(post(make({ google: { reply: { code: 400, body: { error: 'invalid_token' } } } }), { action: 'login', credential: CRED }).ok, false);
  assert.equal(post(make({ google: { reply: { code: 200, body: 'junk' } } }), { action: 'login', credential: CRED }).ok, false);
});

test('badly shaped credentials never reach Google', () => {
  const c = make({ google: { info: good() } });
  for (const bad of ['', 'nope', 'a.b', 'a.b.c.d', null, 5, {}, 'x'.repeat(5000), 'a b.c.d', '../a.b.c'])
    assert.equal(post(c, { action: 'login', credential: bad }).ok, false);
  assert.equal(c.__fetches.length, 0);
});

test('tokens expire', () => {
  const c = make({ google: { info: good() } });
  const { token } = post(c, { action: 'login', credential: CRED });
  assert.equal(post(c, { action: 'read', secret: token }).ok, true);
  const all = JSON.parse(c.__props['mm.sessions']);
  for (const h of Object.keys(all)) all[h] = Date.now() - 1000;      // pretend it ran out a second ago
  c.__props['mm.sessions'] = JSON.stringify(all);
  assert.equal(post(c, { action: 'read', secret: token }).error, 'auth');
});

test('logout ends that token only', () => {
  const c = make({ google: { info: good() } });
  const a = post(c, { action: 'login', credential: CRED }).token, b = post(c, { action: 'login', credential: CRED }).token;
  assert.equal(post(c, { action: 'logout', secret: a }).ok, true);
  assert.equal(post(c, { action: 'read', secret: a }).error, 'auth');
  assert.equal(post(c, { action: 'read', secret: b }).ok, true);
});

test('revokeAllSessions signs everything out', () => {
  const c = make({ google: { info: good() } });
  const { token } = post(c, { action: 'login', credential: CRED });
  c.revokeAllSessions();
  assert.equal(post(c, { action: 'read', secret: token }).error, 'auth');
});

test('only the newest 8 sessions are kept', () => {
  const c = make({ google: { info: good() } });
  const toks = Array.from({ length: 10 }, () => post(c, { action: 'login', credential: CRED }).token);
  assert.equal(Object.keys(JSON.parse(c.__props['mm.sessions'])).length, 8);
  assert.equal(post(c, { action: 'read', secret: toks[9] }).ok, true);
});

test('a damaged session store means signed out, not an error or an open door', () => {
  const c = make({ google: { info: good() } });
  c.__props['mm.sessions'] = '{not json';
  assert.equal(post(c, { action: 'read', secret: 'x' }).error, 'auth');
  c.__props['mm.sessions'] = '[]';
  assert.equal(post(c, { action: 'read', secret: 'x' }).error, 'auth');
});

test('the status ping needs no token and shows no sheet data', () => {
  const c = make();
  const g = JSON.parse(c.doGet({ parameter: { action: 'read' } }).text);
  assert.equal(g.ok, true); assert.equal(g.tabs, undefined); assert.equal(g.data, undefined);
});

test('tx_ puts a quote in front of formula-looking text and leaves real amounts alone', () => {
  const c = make();
  for (const v of ['=1+1', '+cmd', '-cmd', '@SUM(A1)', '\t=1', '=HYPERLINK("http://x","y")']) assert.equal(c.tx_(v), "'" + v);
  for (const v of ['hello', '', '-12.50', '+5', '$5', '1,200', '-3', '.5', '12%', 7, null, true]) assert.equal(c.tx_(v), v);
});

test('the optional SECRET word works as a token only when it is set', () => {
  assert.equal(post(make(), { action: 'read', secret: '' }).error, 'auth');
  const c2 = make({ src: code.replace("const SECRET = '';", "const SECRET = 'abc123';") });
  assert.equal(post(c2, { action: 'read', secret: 'abc123' }).ok, true);
  assert.equal(post(c2, { action: 'read', secret: 'abc124' }).error, 'auth');
  assert.equal(post(c2, { action: 'read', secret: '' }).error, 'auth');
});

test('every refusal says why, with a short code and nothing secret', () => {
  const cases = [
    [{ info: good({ email: 'other@example.com' }) }, 'email-mismatch'],
    [{ info: good({ aud: 'evil.apps.googleusercontent.com' }) }, 'client-id-mismatch'],
    [{ info: good({ email_verified: 'false' }) }, 'email-not-verified'],
    [{ info: good({ iss: 'https://evil.example.com' }) }, 'issuer'],
    [{ info: good({ exp: String(Math.floor(Date.now() / 1000) - 10) }) }, 'expired'],
    [{ reply: { code: 400, body: {} } }, 'google-http-400'],
    [{ reply: { code: 200, body: 'junk' } }, 'google-reply']
  ];
  for (const [google, reason] of cases) {
    const r = post(make({ google }), { action: 'login', credential: CRED });
    assert.equal(r.ok, false); assert.equal(r.error, 'auth'); assert.equal(r.reason, reason);
    assert.equal(r.token, undefined);
  }
  assert.equal(post(make({ google: { info: good() } }), { action: 'login', credential: 'nope' }).reason, 'shape');
});

test('a missing permission to call Google shows up as a fetch reason, not a silent failure', () => {
  const c = make({ google: { info: good() } });
  c.UrlFetchApp.fetch = () => { throw new Error('Authorization is required to perform that action.'); };
  const r = post(c, { action: 'login', credential: CRED });
  assert.equal(r.ok, false); assert.match(r.reason, /^fetch: Authorization is required/);
});

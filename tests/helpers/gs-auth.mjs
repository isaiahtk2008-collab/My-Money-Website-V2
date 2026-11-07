// Test adapter for apps-script.gs. The script now refuses every request that has no valid session token, so the older tests
// (which are about reading, adding, editing and deleting rows) run "signed in": this gives the mocked script the Utilities it
// needs, creates one real session with the script's own code, and adds that token to any request that has none.
// Requests that carry their own token (or none on purpose, with { raw: true }) are left exactly as written.
import crypto from 'node:crypto';

export function authWrap(ctx, opts = {}) {
  const U = (ctx.Utilities = ctx.Utilities || {});
  U.getUuid = U.getUuid || (() => crypto.randomUUID());
  U.DigestAlgorithm = { SHA_256: 'sha256' };
  U.Charset = { UTF_8: 'utf8' };
  // Apps Script returns SIGNED bytes (-128..127); do the same so the script's hex_ is tested on the real shape.
  U.computeDigest = (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b));
  // Some test mocks never keep script properties. Keep the session list in memory, and leave every other key to the test's own mock.
  const origProps = ctx.PropertiesService;
  const mem = {};
  ctx.PropertiesService = {
    getScriptProperties: () => {
      const inner = origProps && origProps.getScriptProperties ? origProps.getScriptProperties() : { getProperty: () => null, setProperty() {} };
      return {
        getProperty: k => (k === 'mm.sessions' ? (mem[k] ?? null) : inner.getProperty(k)),
        setProperty: (k, v) => { if (k === 'mm.sessions') mem[k] = v; else inner.setProperty(k, v); }
      };
    }
  };
  if (opts.raw) return ctx;
  const token = ctx.newSession_().token;
  const rawPost = ctx.doPost;
  ctx.__token = token;
  ctx.__rawPost = rawPost;
  ctx.doPost = e => {
    let body;
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return rawPost(e); }
    if (body && typeof body === 'object' && !Array.isArray(body) && !body.secret && body.action !== 'login') {
      body.secret = token;
      return rawPost({ postData: { contents: JSON.stringify(body) } });
    }
    return rawPost(e);
  };
  // Old tests read with GET ?action=read|check|settings. Reads are POST-only now, so send those the signed-in way.
  const rawGet = ctx.doGet;
  ctx.__rawGet = rawGet;
  ctx.doGet = e => {
    const p = (e && e.parameter) || {};
    if (p.action === 'read' || p.action === 'check' || p.action === 'settings') {
      const body = { action: p.action === 'settings' ? 'settings_get' : p.action };
      if (p.flat !== undefined) body.flat = p.flat;
      if (p.secret) body.secret = p.secret;
      return ctx.doPost({ postData: { contents: JSON.stringify(body) } });
    }
    return rawGet(e);
  };
  return ctx;
}

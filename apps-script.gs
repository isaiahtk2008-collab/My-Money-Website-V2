// My Money sheet connector v2 (reads AND writes).
// Paste over ALL existing code in Extensions > Apps Script, press Save, then
// Deploy > Manage deployments > pencil icon > Version: New version > Deploy.
// (Keep Execute as: Me, Who has access: Anyone. The /exec link stays the same.)
const SECRET = ''; // optional: a word here AND the same word in My Money > Log > Sheet connection

// WRITE: only these tabs can ever be appended to (matched ignoring case and spaces).
// Summary, Master Inventory and other formula tabs are NOT listed, so they can never be touched.
const ALLOWED_TABS = ['Form Responses - Bought', 'Form Responses - PCs', 'Bought Access - Form', 'Form Responses - Sold', 'Form Responses - Sold PCs', 'Sold Access - Form', 'Expenses', 'Investment Tracking Sheet'];

// READ: what the website loads (website name -> tab name). Read-only, nothing is ever changed by reading.
const READ_TABS = { Expenses: 'Expenses', Phones: 'Master Inventory', PCs: 'PCs', Accessories: 'PnA', Investments: 'Investment Tracking Sheet' };

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function findSheet(ss, name) {
  const want = String(name).trim().toLowerCase();
  return ss.getSheets().find(s => s.getName().trim().toLowerCase() === want);
}

function cleanCell(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '' || t === '-' || t === 'N/A' || /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)/.test(t)) return null;
    return t;
  }
  return v === '' || v === undefined ? null : v;
}

function readTab(ss, name, tz) {
  const sheet = findSheet(ss, name);
  if (!sheet) return { sheet: name, headers: [], rows: [], missing: true };
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { sheet: name, headers: [], rows: [] };
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(h => String(h).trim());
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = cleanCell(values[r][i], tz); });
    rows.push(o);
  }
  // drop completely empty rows at the bottom (formula columns can stretch the used range)
  while (rows.length && Object.keys(rows[rows.length - 1]).every(k => rows[rows.length - 1][k] === null)) rows.pop();
  return { sheet: name, headers, rows };
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action !== 'read') return json({ ok: true, service: 'my-money-entry', version: 2, read: true });
  if (SECRET && p.secret !== SECRET) return json({ ok: false, error: 'auth' });
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const tabs = {};
    Object.keys(READ_TABS).forEach(key => { tabs[key] = readTab(ss, READ_TABS[key], tz); });
    return json({ ok: true, version: 2, at: new Date().toISOString(), tabs });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function seenId(id) {
  if (!id) return false;
  const cache = CacheService.getScriptCache();
  if (cache.get('id:' + id)) return true;
  try {
    const map = JSON.parse(PropertiesService.getScriptProperties().getProperty('SEEN_IDS') || '{}');
    if (map[id]) { cache.put('id:' + id, '1', 21600); return true; }
  } catch (e) {}
  return false;
}

function markId(id) {
  if (!id) return;
  CacheService.getScriptCache().put('id:' + id, '1', 21600);
  const props = PropertiesService.getScriptProperties();
  let map = {};
  try { map = JSON.parse(props.getProperty('SEEN_IDS') || '{}') || {}; } catch (e) {}
  const now = Date.now();
  map[id] = now;
  let entries = Object.keys(map).map(k => [k, map[k]]).filter(p => p[1] >= now - 30 * 86400000);
  if (entries.length > 200) { entries.sort((a, b) => b[1] - a[1]); entries = entries.slice(0, 200); }
  const out = {};
  entries.forEach(p => { out[p[0]] = p[1]; });
  props.setProperty('SEEN_IDS', JSON.stringify(out));
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const body = JSON.parse(e.postData.contents || '{}');
    if (SECRET && body.secret !== SECRET) return json({ ok: false, error: 'auth' });

    // Ignore retries of an entry that already landed
    if (seenId(body.id)) return json({ ok: true, dup: true });

    // Find the tab (ignores case and trailing spaces)
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const reqTab = String(body.tab || '').trim().toLowerCase();
    if (!ALLOWED_TABS.some(t => t.toLowerCase() === reqTab)) return json({ ok: false, error: 'tab not allowed: ' + body.tab });
    const sheet = findSheet(ss, reqTab);
    if (!sheet) return json({ ok: false, error: 'no tab: ' + body.tab });

    // Match incoming field names to column headers
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1).getValues()[0].map(norm);
    const inVals = body.values || {};
    const matchedCols = {}, matchedKeys = new Set();

    headers.forEach((h, idx) => {
      if (h === 'timestamp') {
        matchedCols[idx + 1] = new Date();
      } else {
        const k = Object.keys(inVals).find(key => norm(key) === h);
        if (k !== undefined) {
          matchedKeys.add(k);
          let v = inVals[k];
          if (v && typeof v === 'object' && v.$date) {
            const [y, m, d] = v.$date.split('-').map(Number);
            v = new Date(y, m - 1, d);
          }
          matchedCols[idx + 1] = v;
        }
      }
    });
    const unmatched = Object.keys(inVals).filter(k => !matchedKeys.has(k));

    // Next free row, judged only by the columns we write (formula columns are left alone)
    const cols = Object.keys(matchedCols).map(Number);
    let targetRow = 2;
    const maxRows = sheet.getMaxRows();
    if (maxRows > 1 && cols.length > 0) {
      const data = sheet.getRange(2, 1, maxRows - 1, sheet.getLastColumn()).getValues();
      for (let r = data.length - 1; r >= 0; r--) {
        if (cols.some(c => data[r][c - 1] !== '')) {
          targetRow = r + 3;
          break;
        }
      }
    }

    // Safety: never overwrite anything. Refuse if any target cell already holds a value or a formula.
    if (targetRow <= maxRows) {
      const clash = cols.some(c => { const cell = sheet.getRange(targetRow, c); return cell.getFormula() !== '' || cell.getValue() !== ''; });
      if (clash) return json({ ok: false, error: 'target row not empty' });
    }

    // Write only the cells we have values for
    if (targetRow > maxRows) sheet.insertRowsAfter(maxRows, targetRow - maxRows);
    cols.forEach(c => sheet.getRange(targetRow, c).setValue(matchedCols[c]));

    markId(body.id);
    return json({ ok: true, row: targetRow, unmatched });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

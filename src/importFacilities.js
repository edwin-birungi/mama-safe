'use strict';
const fs = require('fs');
const { normalizePhone } = require('./phone');

// Minimal CSV parser (handles quoted fields, commas and doubled quotes inside quotes).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

// CSV columns: code,name,level,area,phone,lat,lng,open24,services
// Existing facilities with the same code are updated, so you can re-import a corrected file.
function importCsv(db, file) {
  const [header, ...data] = parseCsv(fs.readFileSync(file, 'utf8'));
  const idx = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
  for (const need of ['code', 'name', 'area']) {
    if (!(need in idx)) throw new Error(`CSV is missing the "${need}" column`);
  }
  const get = (r, k) => (k in idx && r[idx[k]] != null ? r[idx[k]].trim() : '');
  const up = db.prepare(`INSERT INTO facilities (code, name, level, area, phone, lat, lng, open24, services)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, level=excluded.level, area=excluded.area, phone=excluded.phone,
      lat=excluded.lat, lng=excluded.lng, open24=excluded.open24, services=excluded.services`);
  let n = 0;
  const skipped = [];
  for (const r of data) {
    const code = get(r, 'code'), name = get(r, 'name'), area = get(r, 'area');
    if (!code || !name || !area) { skipped.push(r.join(',')); continue; }
    const lat = parseFloat(get(r, 'lat')), lng = parseFloat(get(r, 'lng'));
    const open24 = /^(1|true|yes|y|24)/i.test(get(r, 'open24')) ? 1 : 0;
    up.run(code, name, get(r, 'level') || null, area, normalizePhone(get(r, 'phone')),
      Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, open24, get(r, 'services') || null);
    n++;
  }
  return { imported: n, skipped };
}

module.exports = { parseCsv, importCsv };

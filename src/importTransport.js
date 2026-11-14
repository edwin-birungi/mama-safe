'use strict';
// Load drivers from a CSV: name,kind,phone,area,lat,lng,radius_km,facility_code,notes
// Only name, kind and phone are required. Re-running is safe: rows are matched by phone number.
const fs = require('fs');
const { parseCsv } = require('./importFacilities');
const facilities = require('./facilities');
const transport = require('./transport');
const { normalizePhone } = require('./phone');

function importCsv(db, file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const out = { imported: 0, updated: 0, skipped: [] };
  if (!rows.length) return out;
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = (r, name) => { const i = head.indexOf(name); return i < 0 ? '' : (r[i] || '').trim(); };
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const fields = {
      name: col(r, 'name'), kind: (col(r, 'kind') || 'other').toLowerCase(), phone: col(r, 'phone'),
      area: col(r, 'area') || col(r, 'district'), notes: col(r, 'notes') || undefined
    };
    for (const k of ['lat', 'lng', 'radius_km']) if (col(r, k) !== '') fields[k] = col(r, k);
    const code = col(r, 'facility_code');
    if (code) {
      const f = facilities.byCode(db, code);
      if (!f) { out.skipped.push({ line, reason: `unknown facility code ${code}` }); return; }
      fields.facility_id = f.id;
    }
    try {
      const phone = normalizePhone(fields.phone);
      const existing = phone && db.prepare('SELECT id FROM transport_providers WHERE phone = ?').get(phone);
      if (existing) { transport.update(db, existing.id, fields); out.updated++; } else { transport.create(db, fields); out.imported++; }
    } catch (e) { out.skipped.push({ line, reason: e.message }); }
  });
  return out;
}

module.exports = { importCsv };

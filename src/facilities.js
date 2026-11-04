'use strict';

const KINDS = ['hospital', 'health_centre', 'clinic', 'other'];
const KIND_ORDER = "CASE kind WHEN 'hospital' THEN 0 WHEN 'health_centre' THEN 1 WHEN 'clinic' THEN 2 ELSE 3 END";

function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = (x) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const hasCoords = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng);

// open24 is three-valued: true, false, or null (not known).
function shape(row, from) {
  const f = { ...row, open24: row.open24 == null ? null : !!row.open24 };
  if (from && row.lat != null && row.lng != null) {
    f.distanceKm = Math.round(distanceKm(from.lat, from.lng, row.lat, row.lng) * 10) / 10;
  }
  return f;
}

// What the public API may show. alert_phone (a staff mobile) and internal notes never leave the server.
function publicView(f) {
  const { alert_phone, notes, ...rest } = f;
  return rest;
}

const like = (s) => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';

// Facilities, nearest first when lat/lng are given, otherwise hospitals first then by name.
// Filters: kind, open24, q (matches name or district). limit/offset page the result.
function list(db, { lat, lng, kind, q, open24, limit, offset = 0 } = {}) {
  const from = hasCoords(lat, lng) ? { lat, lng } : null;
  const where = [], args = [];
  if (kind && KINDS.includes(kind)) { where.push('kind = ?'); args.push(kind); }
  if (open24) where.push('open24 = 1');
  if (q && String(q).trim()) {
    where.push("(name LIKE ? ESCAPE '\\' OR area LIKE ? ESCAPE '\\')");
    args.push(like(String(q).trim()), like(String(q).trim()));
  }
  const sql = `SELECT * FROM facilities ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${KIND_ORDER}, name`;
  const rows = db.prepare(sql).all(...args).map((r) => shape(r, from));
  if (from) rows.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  return limit ? rows.slice(offset, offset + limit) : rows;
}

const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM facilities').get().n;

const byId = (db, id) => {
  const r = db.prepare('SELECT * FROM facilities WHERE id = ?').get(id);
  return r ? shape(r) : null;
};
const byCode = (db, code) => {
  const r = db.prepare('SELECT * FROM facilities WHERE code = ? COLLATE NOCASE').get(String(code));
  return r ? shape(r) : null;
};
// SMS and USSD users can give either the short code (MULAGO) or the number from a CLINICS reply.
const byCodeOrId = (db, s) => (/^\d+$/.test(String(s)) ? byId(db, Number(s)) : byCode(db, s));

const areas = (db) => db.prepare('SELECT DISTINCT area FROM facilities ORDER BY area').all().map((r) => r.area);
// Districts starting with the typed letters, for USSD where nobody can scroll 146 districts.
const searchAreas = (db, prefix, limit = 7) =>
  db.prepare("SELECT DISTINCT area FROM facilities WHERE area LIKE ? ESCAPE '\\' ORDER BY area LIMIT ?")
    .all(String(prefix).trim().replace(/[\\%_]/g, '\\$&') + '%', limit).map((r) => r.area);
const inArea = (db, area) =>
  db.prepare(`SELECT * FROM facilities WHERE area = ? ORDER BY ${KIND_ORDER}, name`).all(area).map((r) => shape(r));

// The number to show first: main line, else emergency line, else toll-free.
const bestPhone = (f) => (f && (f.phone || f.emergency_phone || f.toll_free)) || null;

module.exports = { KINDS, distanceKm, hasCoords, publicView, list, count, byId, byCode, byCodeOrId, areas, searchAreas, inArea, bestPhone };

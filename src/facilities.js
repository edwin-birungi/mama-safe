'use strict';

function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = (x) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const hasCoords = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng);

function shape(row, from) {
  const f = { ...row, open24: !!row.open24 };
  if (from && row.lat != null && row.lng != null) {
    f.distanceKm = Math.round(distanceKm(from.lat, from.lng, row.lat, row.lng) * 10) / 10;
  }
  return f;
}

// Facilities, nearest first when lat/lng are given.
function list(db, { lat, lng, open24 } = {}) {
  const from = hasCoords(lat, lng) ? { lat, lng } : null;
  let rows = db.prepare('SELECT * FROM facilities ORDER BY name').all().map((r) => shape(r, from));
  if (open24) rows = rows.filter((r) => r.open24);
  if (from) rows.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  return rows;
}

const byId = (db, id) => {
  const r = db.prepare('SELECT * FROM facilities WHERE id = ?').get(id);
  return r ? shape(r) : null;
};
const byCode = (db, code) => {
  const r = db.prepare('SELECT * FROM facilities WHERE code = ? COLLATE NOCASE').get(String(code));
  return r ? shape(r) : null;
};
const areas = (db) => db.prepare('SELECT DISTINCT area FROM facilities ORDER BY area').all().map((r) => r.area);
const inArea = (db, area) =>
  db.prepare('SELECT * FROM facilities WHERE area = ? ORDER BY name').all(area).map((r) => shape(r));

module.exports = { distanceKm, hasCoords, list, byId, byCode, areas, inArea };

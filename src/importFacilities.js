'use strict';
const fs = require('fs');
const { normalizePhone, isTollFree, splitPhones } = require('./phone');
const { distanceKm } = require('./facilities');

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

// Accepted column names, so a Ministry of Health or district export can be imported as it is.
const ALIASES = {
  code: ['code', 'facility_code', 'id', 'facility_id', 'hf_code'],
  name: ['name', 'facility_name', 'facility', 'health_facility', 'hf_name', 'hospital_name'],
  kind: ['kind'],
  level: ['level', 'facility_level', 'hf_level', 'level_of_care', 'type'],
  area: ['area', 'district', 'district_name'],
  phone: ['phone', 'telephone', 'tel', 'phone_number', 'contact'],
  emergency_phone: ['emergency_phone', 'emergency'],
  toll_free: ['toll_free', 'tollfree', 'toll_free_line'],
  alert_phone: ['alert_phone', 'alert_mobile'],
  email: ['email', 'e-mail'],
  website: ['website', 'url'],
  lat: ['lat', 'latitude', 'y'],
  lng: ['lng', 'lon', 'long', 'longitude', 'x'],
  open24: ['open24', 'open_24', '24_hours', 'open_24_hours'],
  services: ['services'],
  source: ['source'],
  contact_confidence: ['contact_confidence', 'confidence'],
  researched_on: ['researched_on', 'verified_on'],
  notes: ['notes']
};

function deriveKind(level, name) {
  const t = `${level || ''} ${name || ''}`.toLowerCase();
  if (/hospital|referral/.test(t)) return 'hospital';
  if (/health\s*cent(re|er)|\bhc\s*(iv|iii|ii|4|3|2)\b/.test(t)) return 'health_centre';
  if (/clinic|dispensar|medical\s*cent(re|er)/.test(t)) return 'clinic';
  return 'other';
}

function deriveLevel(name) {
  const m = /\b(?:HC|Health\s*Cent(?:re|er))\s*(IV|III|II|4|3|2)\b/i.exec(name || '');
  if (!m) return null;
  const n = { 4: 'IV', 3: 'III', 2: 'II' }[m[1]] || m[1].toUpperCase();
  return 'HC ' + n;
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const blank = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

// Insert or update by code. Only the fields present in `rec` are written, so re-importing a file
// with fewer columns never wipes fields (like alert_phone) that were set elsewhere.
function upsert(db, rec) {
  const keys = Object.keys(rec);
  const sets = keys.filter((k) => k !== 'code').map((k) => `${k} = excluded.${k}`).join(', ');
  db.prepare(`INSERT INTO facilities (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})
              ON CONFLICT(code) DO UPDATE SET ${sets}`).run(...keys.map((k) => rec[k]));
}

function uniqueCode(db, base) {
  let code = base, n = 2;
  while (db.prepare('SELECT 1 FROM facilities WHERE code = ?').get(code)) code = `${base}-${n++}`.slice(0, 60);
  return code;
}

// Import a facility CSV. Required: a name and a district (area). Everything else is optional.
function importCsv(db, file) {
  const [header, ...data] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const names = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const i = names.findIndex((n) => aliases.includes(n));
    if (i >= 0) col[field] = i;
  }
  for (const need of ['name', 'area']) {
    if (!(need in col)) throw new Error(`CSV needs a "${need}" column (or ${ALIASES[need].join(', ')}). Found: ${names.join(', ')}`);
  }
  let imported = 0;
  const skipped = [];
  for (const r of data) {
    const get = (f) => (f in col ? blank(r[col[f]]) : undefined);
    const name = get('name'), area = get('area');
    if (!name || !area) { skipped.push(r.join(',')); continue; }
    const rec = { name, area };
    const code = get('code');
    rec.code = code || `${slug(name)}-${slug(area)}`.slice(0, 60);
    const level = get('level');
    if (level !== undefined) rec.level = level || deriveLevel(name);
    else if (deriveLevel(name)) rec.level = deriveLevel(name);
    rec.kind = get('kind') || deriveKind(level, name);
    for (const f of ['email', 'website', 'services', 'source', 'contact_confidence', 'researched_on', 'notes']) {
      if (f in col) rec[f] = get(f);
    }
    // Phones: a "phone" cell may hold several numbers; toll-free ones are split out.
    for (const f of ['emergency_phone', 'toll_free', 'alert_phone']) {
      if (f in col) rec[f] = get(f) ? normalizePhone(get(f)) : null;
    }
    if ('phone' in col) {
      const nums = splitPhones(get('phone'));
      rec.phone = nums.find((n) => !isTollFree(n)) || null;
      const tf = nums.find((n) => isTollFree(n));
      if (tf && !rec.toll_free) rec.toll_free = tf;
    }
    if ('lat' in col && 'lng' in col) {
      const lat = parseFloat(get('lat')), lng = parseFloat(get('lng'));
      rec.lat = Number.isFinite(lat) ? lat : null;
      rec.lng = Number.isFinite(lng) ? lng : null;
    }
    if ('open24' in col) {
      const v = (get('open24') || '').toLowerCase();
      rec.open24 = /^(1|true|yes|y|24)/.test(v) ? 1 : /^(0|false|no|n)/.test(v) ? 0 : null;
    }
    if (!rec.contact_confidence && ('phone' in col || 'toll_free' in col)) {
      rec.contact_confidence = rec.phone || rec.toll_free || rec.emergency_phone ? 'low' : 'none';
    }
    if (!code) rec.code = uniqueCodeIfTaken(db, rec.code, rec.name, rec.area);
    upsert(db, rec);
    imported++;
  }
  return { imported, skipped };
}

// Generated codes (no code column) are stable per name+district; only add a suffix for a genuine clash.
function uniqueCodeIfTaken(db, code, name, area) {
  const row = db.prepare('SELECT name, area FROM facilities WHERE code = ?').get(code);
  return !row || (row.name === name && row.area === area) ? code : uniqueCode(db, code);
}

// Import an OpenStreetMap Overpass JSON export (see the README for the query).
// Facilities already in the database (same name within 1.5 km) are skipped, so curated rows win.
function importOsm(db, jsonFileOrObject) {
  const data = typeof jsonFileOrObject === 'string' ? JSON.parse(fs.readFileSync(jsonFileOrObject, 'utf8')) : jsonFileOrObject;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const known = new Map();
  for (const f of db.prepare('SELECT name, lat, lng FROM facilities WHERE lat IS NOT NULL').all()) {
    const k = norm(f.name);
    if (!known.has(k)) known.set(k, []);
    known.get(k).push(f);
  }
  const today = new Date().toISOString().slice(0, 10);
  const out = { imported: 0, skipped: { unnamed: 0, noCoordinates: 0, duplicate: 0 } };
  for (const el of data.elements || []) {
    const t = el.tags || {};
    if (!t.name) { out.skipped.unnamed++; continue; }
    const lat = el.lat ?? (el.center && el.center.lat), lng = el.lon ?? (el.center && el.center.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { out.skipped.noCoordinates++; continue; }
    const key = norm(t.name);
    if ((known.get(key) || []).some((f) => distanceKm(lat, lng, f.lat, f.lng) < 1.5)) { out.skipped.duplicate++; continue; }

    const isHospital = t.amenity === 'hospital' || t.healthcare === 'hospital';
    const level = deriveLevel(t.name);
    const kind = isHospital ? 'hospital' : level ? 'health_centre' : deriveKind(null, t.name) === 'other' ? 'clinic' : deriveKind(null, t.name);
    const nums = splitPhones(t.phone || t['contact:phone'] || '');
    const phone = nums.find((n) => !isTollFree(n)) || null;
    const toll = nums.find((n) => isTollFree(n)) || null;
    const rec = {
      code: `OSM-${el.type[0]}${el.id}`,
      name: t.name.trim(), kind, level,
      area: t['addr:district'] || t['is_in:district'] || t['addr:county'] || t['addr:city'] || t['addr:subcounty'] || 'Unknown area',
      phone, toll_free: toll,
      email: blank(t.email || t['contact:email']),
      website: blank(t.website || t['contact:website']),
      lat, lng,
      open24: t.opening_hours === '24/7' ? 1 : null,
      services: blank(t['healthcare:speciality'] && t['healthcare:speciality'].replace(/;/g, ', ')),
      source: 'OpenStreetMap contributors (ODbL) https://www.openstreetmap.org/' + el.type + '/' + el.id,
      contact_confidence: phone || toll ? 'low' : 'none',
      researched_on: today
    };
    upsert(db, rec);
    if (!known.has(key)) known.set(key, []);
    known.get(key).push({ lat, lng });
    out.imported++;
  }
  return out;
}

module.exports = { parseCsv, importCsv, importOsm, deriveKind, deriveLevel };

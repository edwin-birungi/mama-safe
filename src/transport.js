'use strict';
// Emergency transport: a directory of people who can carry a mother to care (ambulances, boda riders,
// taxi drivers, community volunteers) and the pickup requests sent to them when an alert is raised.
//
// Privacy rules, on purpose:
//  - A pickup SMS to drivers says only "a pregnant woman" and where to find her. No name, no phone,
//    no symptoms. Her number goes only to the ONE driver who accepts.
//  - Drivers' base locations and internal notes are never returned by the public views.
//  - Nobody is contacted unless staff have marked them active, and a driver can text BUSY at any time.
const config = require('./config');
const facilities = require('./facilities');
const sms = require('./sms');
const { normalizePhone, local } = require('./phone');

const KINDS = ['ambulance', 'boda', 'taxi', 'volunteer', 'other'];
const KIND_LABEL = { ambulance: 'Ambulance', boda: 'Boda rider', taxi: 'Taxi / car', volunteer: 'Volunteer driver', other: 'Transport' };
const KIND_RANK = Object.fromEntries(KINDS.map((k, i) => [k, i]));
const round1 = (n) => Math.round(n * 10) / 10;

function shape(row, from) {
  const p = { ...row, available: !!row.available, active: !!row.active };
  if (from && row.lat != null && row.lng != null) p.distanceKm = round1(facilities.distanceKm(from.lat, from.lng, row.lat, row.lng));
  return p;
}

// What a signed-in mother may see: enough to call. Never the base location, notes or staff fields.
function publicView(p) {
  return { id: p.id, name: p.name, kind: p.kind, kindLabel: KIND_LABEL[p.kind] || 'Transport', phone: p.phone, area: p.area, distanceKm: p.distanceKm == null ? null : p.distanceKm,
    // Map position rounded to about 1 km, so a driver's exact base is never shown.
    lat: p.lat == null ? null : Math.round(p.lat * 100) / 100, lng: p.lng == null ? null : Math.round(p.lng * 100) / 100 };
}

const byId = (db, id) => {
  const r = db.prepare('SELECT * FROM transport_providers WHERE id = ?').get(id);
  return r ? shape(r) : null;
};
const byPhone = (db, phone) => {
  const r = db.prepare('SELECT * FROM transport_providers WHERE phone = ? AND active = 1').get(phone);
  return r ? shape(r) : null;
};

// Staff view: everyone, including inactive.
const listAll = (db) => db.prepare('SELECT * FROM transport_providers ORDER BY active DESC, area, name').all().map((r) => shape(r));

const sameArea = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Active, available drivers who can reach the mother, nearest first.
//  - With GPS: within each driver's own service radius, sorted by distance. Drivers with no saved base
//    but in the same district come after them (distance unknown).
//  - Without GPS (USSD / SMS): drivers in her district, or attached to her facility, ambulances first.
function nearby(db, { lat, lng, area, facilityId, limit } = {}) {
  const from = facilities.hasCoords(lat, lng) ? { lat, lng } : null;
  const rows = db.prepare('SELECT * FROM transport_providers WHERE active = 1 AND available = 1').all().map((r) => shape(r, from));
  let out;
  if (from) {
    const located = rows.filter((p) => p.distanceKm != null && p.distanceKm <= p.radius_km).sort((a, b) => a.distanceKm - b.distanceKm);
    const unlocated = rows.filter((p) => p.distanceKm == null && (sameArea(p.area, area) || (facilityId && p.facility_id === facilityId)));
    out = [...located, ...unlocated];
  } else {
    out = rows.filter((p) => sameArea(p.area, area) || (facilityId && p.facility_id === facilityId))
      .sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.name.localeCompare(b.name));
  }
  return limit ? out.slice(0, limit) : out;
}

// Pick who to ask: the closest ambulance (it can carry a patient lying down) plus the closest others.
function pick(list, count) {
  const first = list.find((p) => p.kind === 'ambulance');
  const chosen = first ? [first] : [];
  for (const p of list) {
    if (chosen.length >= count) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  return chosen;
}

const mapsLink = (lat, lng) => `https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)}`;

// Ask the nearest drivers to collect the mother. Never throws: a transport problem must not stop an alert.
function dispatch(db, { alert, facility, lat, lng, area, facilityId }) {
  const none = { asked: 0, providers: [], nearby: [] };
  if (!config.transport.autoDispatch) return none;
  let list;
  try {
    list = nearby(db, { lat, lng, area, facilityId });
  } catch (e) { console.error('transport lookup failed', e); return none; }
  if (!list.length) return none;
  const chosen = pick(list, config.transport.dispatchCount);
  const where = facilities.hasCoords(lat, lng) ? `Location: ${mapsLink(lat, lng)}` : `Area: ${area || 'unknown'} (no GPS)`;
  const asked = [];
  for (const p of chosen) {
    try {
      db.prepare('INSERT OR IGNORE INTO transport_requests (alert_id, provider_id, status, sent_at) VALUES (?,?,?,?)')
        .run(alert.id, p.id, 'sent', new Date().toISOString());
      sms.send(db, p.phone,
        `MAMASAFE PICKUP #${alert.id}: a pregnant woman needs urgent transport${facility ? ' to ' + facility.name : ''}. ${where}. ` +
        `Reply GO ${alert.id} if you can take her now. Her number goes to the first driver who replies.`, 'transport-request');
      asked.push(p);
    } catch (e) { console.error('transport send failed', e); }
  }
  return { asked: asked.length, providers: asked.map(publicView), nearby: list.slice(0, 5).map(publicView) };
}

// A driver texts "GO 12". The first to reply gets the job and the mother's number; the rest are told it is taken.
function accept(db, alertId, provider) {
  const req = db.prepare('SELECT * FROM transport_requests WHERE alert_id = ? AND provider_id = ?').get(alertId, provider.id);
  if (!req) return { error: `MamaSafe: no pickup request #${alertId} for you.` };
  const row = db.prepare(`
    SELECT a.*, m.name AS mother_name, m.phone AS mother_phone, m.contact_phone AS contact_phone, f.name AS facility_name, f.alert_phone AS facility_alert_phone
    FROM alerts a JOIN mothers m ON m.id = a.mother_id LEFT JOIN facilities f ON f.id = a.facility_id WHERE a.id = ?`).get(alertId);
  if (!row) return { error: `MamaSafe: no pickup request #${alertId} for you.` };
  if (req.status === 'accepted') return { error: `MamaSafe: pickup #${alertId} is already yours. Call ${local(row.mother_phone)}.` };
  const taken = db.prepare("SELECT 1 FROM transport_requests WHERE alert_id = ? AND status = 'accepted'").get(alertId);
  if (taken) {
    db.prepare("UPDATE transport_requests SET status = 'taken' WHERE id = ?").run(req.id);
    return { error: `MamaSafe: pickup #${alertId} was already taken by another driver. Thank you for answering.` };
  }

  // Node runs this synchronously, so no other reply can slip in between the check above and this update.
  db.prepare("UPDATE transport_requests SET status = 'accepted', accepted_at = ? WHERE id = ?").run(new Date().toISOString(), req.id);
  db.prepare('UPDATE transport_providers SET available = 0 WHERE id = ?').run(provider.id); // busy until AVAILABLE
  const others = db.prepare("SELECT r.id, p.phone FROM transport_requests r JOIN transport_providers p ON p.id = r.provider_id WHERE r.alert_id = ? AND r.id != ? AND r.status = 'sent'").all(alertId, req.id);
  for (const o of others) {
    db.prepare("UPDATE transport_requests SET status = 'taken' WHERE id = ?").run(o.id);
    sms.send(db, o.phone, `MamaSafe: pickup #${alertId} has been taken by another driver. Thank you.`, 'transport-update');
  }

  const label = KIND_LABEL[provider.kind] || 'Driver';
  sms.send(db, row.mother_phone, `MamaSafe: ${provider.name} (${label.toLowerCase()}) is coming to you. Call ${local(provider.phone)}. Stay where you are and keep your phone on.`, 'transport-update');
  if (row.facility_alert_phone) {
    sms.send(db, row.facility_alert_phone, `MAMASAFE #${alertId}: transport is on the way, ${provider.name} ${local(provider.phone)}. Expect the mother soon.`, 'transport-update');
  }
  if (row.contact_phone) {
    sms.send(db, row.contact_phone, `MamaSafe: ${provider.name} ${local(provider.phone)} is going to collect the mother you were told about.`, 'transport-update');
  }
  const pickup = facilities.hasCoords(row.lat, row.lng) ? mapsLink(row.lat, row.lng) : 'no GPS, ask her where she is';
  return {
    ok: true,
    reply: `MamaSafe: pickup #${alertId} is yours. Call ${row.mother_name ? row.mother_name + ' ' : ''}${local(row.mother_phone)} now. Pickup: ${pickup}.${row.facility_name ? ' Take her to ' + row.facility_name + '.' : ''} Text BUSY if you cannot go.`
  };
}

function setAvailable(db, provider, on) {
  db.prepare('UPDATE transport_providers SET available = ? WHERE id = ?').run(on ? 1 : 0, provider.id);
}

// SMS keywords from a driver. Returns the reply text.
function handleSms(db, provider, cmd, args) {
  if (cmd === 'GO') {
    const arg = String(args[0] || '').replace(/^#/, '');
    const id = /^\d+$/.test(arg) ? Number(arg) : NaN;
    if (!Number.isInteger(id)) return 'MamaSafe: text GO and the pickup number, e.g. GO 12.';
    const r = accept(db, id, provider);
    return r.error || r.reply;
  }
  if (cmd === 'BUSY') { setAvailable(db, provider, false); return 'MamaSafe: you are marked BUSY and will not get pickup requests. Text AVAILABLE when you can drive again.'; }
  if (cmd === 'AVAILABLE') { setAvailable(db, provider, true); return 'MamaSafe: you are marked AVAILABLE. Thank you for helping mothers reach care.'; }
  return null;
}

// Transport sent for one alert, for the dashboard.
function forAlert(db, alertId) {
  return db.prepare(`SELECT r.status, r.sent_at, r.accepted_at, p.name, p.kind, p.phone
    FROM transport_requests r JOIN transport_providers p ON p.id = r.provider_id WHERE r.alert_id = ? ORDER BY r.id`).all(alertId);
}

// ---- staff-maintained directory
function clean(fields, { partial = false } = {}) {
  const out = {};
  const has = (k) => fields[k] !== undefined;
  if (!partial || has('name')) {
    const name = String(fields.name || '').trim().slice(0, 60);
    if (!name) throw Object.assign(new Error('Name is required.'), { status: 400 });
    out.name = name;
  }
  if (!partial || has('kind')) {
    if (!KINDS.includes(fields.kind)) throw Object.assign(new Error(`Kind must be one of: ${KINDS.join(', ')}.`), { status: 400 });
    out.kind = fields.kind;
  }
  if (!partial || has('phone')) {
    const phone = normalizePhone(fields.phone);
    if (!phone) throw Object.assign(new Error('Enter a valid mobile number.'), { status: 400 });
    out.phone = phone;
  }
  if (has('area')) out.area = String(fields.area || '').trim().slice(0, 60) || null;
  for (const k of ['lat', 'lng']) {
    if (!has(k)) continue;
    if (fields[k] === null || fields[k] === '') { out[k] = null; continue; }
    const v = Number(fields[k]);
    if (!Number.isFinite(v) || Math.abs(v) > (k === 'lat' ? 90 : 180)) throw Object.assign(new Error(`${k} is not a valid coordinate.`), { status: 400 });
    out[k] = v;
  }
  if ((out.lat == null) !== (out.lng == null) && has('lat') && has('lng')) throw Object.assign(new Error('Give both lat and lng, or neither.'), { status: 400 });
  if (has('radius_km')) {
    const v = Number(fields.radius_km);
    if (!Number.isFinite(v) || v <= 0 || v > 200) throw Object.assign(new Error('radius_km must be between 0 and 200.'), { status: 400 });
    out.radius_km = v;
  }
  if (has('facility_id')) {
    if (fields.facility_id === null || fields.facility_id === '') out.facility_id = null;
    else out.facility_id = Number(fields.facility_id);
  }
  if (has('notes')) out.notes = String(fields.notes || '').slice(0, 300) || null;
  for (const k of ['available', 'active']) if (has(k)) out[k] = fields[k] ? 1 : 0;
  return out;
}

function create(db, fields) {
  const v = clean(fields);
  if (v.facility_id && !facilities.byId(db, v.facility_id)) throw Object.assign(new Error('Unknown facility.'), { status: 400 });
  if (db.prepare('SELECT 1 FROM transport_providers WHERE phone = ?').get(v.phone)) throw Object.assign(new Error('A driver with this number is already listed.'), { status: 409 });
  const today = new Date().toISOString().slice(0, 10);
  const { lastInsertRowid } = db.prepare(`INSERT INTO transport_providers (name, kind, phone, area, lat, lng, radius_km, facility_id, available, active, verified_on, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(v.name, v.kind, v.phone, v.area ?? null, v.lat ?? null, v.lng ?? null, v.radius_km ?? 15, v.facility_id ?? null,
      v.available ?? 1, v.active ?? 1, today, v.notes ?? null, new Date().toISOString());
  return byId(db, Number(lastInsertRowid));
}

function update(db, id, fields) {
  const cur = byId(db, id);
  if (!cur) throw Object.assign(new Error('Unknown driver.'), { status: 404 });
  const v = clean(fields, { partial: true });
  if (v.facility_id && !facilities.byId(db, v.facility_id)) throw Object.assign(new Error('Unknown facility.'), { status: 400 });
  if (v.phone && v.phone !== cur.phone && db.prepare('SELECT 1 FROM transport_providers WHERE phone = ?').get(v.phone)) throw Object.assign(new Error('A driver with this number is already listed.'), { status: 409 });
  const keys = Object.keys(v);
  if (keys.length) {
    db.prepare(`UPDATE transport_providers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => v[k]), id);
  }
  return byId(db, id);
}

module.exports = { KINDS, KIND_LABEL, publicView, byId, byPhone, listAll, nearby, pick, dispatch, accept, handleSms, setAvailable, forAlert, create, update };

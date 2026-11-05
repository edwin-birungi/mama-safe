'use strict';
const facilities = require('./facilities');
const sms = require('./sms');
const schedule = require('./schedule');
const { labelsFor } = require('./triage');
const config = require('./config');
const { local } = require('./phone');

const DEDUPE_MS = 5 * 60 * 1000;

// Pick where to send an emergency. Prefer 24-hour facilities (they can handle emergencies at night).
//  1. With GPS: the nearest 24-hour facility (any facility if none is 24-hour).
//  2. Without GPS (USSD/SMS): the mother's own facility if it is 24-hour, else a 24-hour facility
//     in the same area, else her own facility.
function chooseFacility(db, mother, lat, lng) {
  const all = facilities.list(db);
  if (!all.length) return null;
  const h24 = all.filter((f) => f.open24);
  if (facilities.hasCoords(lat, lng)) {
    const pool = facilities.list(db, { lat, lng, open24: h24.length > 0 }).filter((f) => f.distanceKm != null);
    return pool[0] || h24[0] || all[0];
  }
  const own = mother.facility_id ? facilities.byId(db, mother.facility_id) : null;
  if (own && own.open24) return own;
  if (own) return h24.find((f) => f.area === own.area) || own;
  return h24[0] || all[0];
}

function createAlert(db, { mother, symptoms = ['sos'], lat, lng, channel }) {
  // Duplicate protection: network retries or double taps must not page the facility twice.
  const recent = db
    .prepare("SELECT * FROM alerts WHERE mother_id = ? AND status = 'new' AND created_at > ? ORDER BY id DESC LIMIT 1")
    .get(mother.id, new Date(Date.now() - DEDUPE_MS).toISOString());
  if (recent) return { alert: shape(recent), facility: facilities.byId(db, recent.facility_id), notified: !!recent.notified, duplicate: true };

  const facility = chooseFacility(db, mother, lat, lng);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO alerts (mother_id, facility_id, level, symptoms, lat, lng, channel, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(mother.id, facility ? facility.id : null, 'emergency', JSON.stringify(symptoms),
      facilities.hasCoords(lat, lng) ? lat : null, facilities.hasCoords(lat, lng) ? lng : null, channel, new Date().toISOString());
  const id = Number(lastInsertRowid);

  const g = schedule.gestation(mother.lmp);
  const who = mother.name || 'Mother';
  const where = facilities.hasCoords(lat, lng) ? ` GPS ${lat.toFixed(4)},${lng.toFixed(4)}.` : '';
  // Only a mobile number can receive SMS. Landlines and toll-free lines cannot, so a facility
  // without an alert_phone is NOT notified, and we say so instead of pretending.
  let notified = false;
  if (facility && facility.alert_phone) {
    sms.send(db, facility.alert_phone,
      `MAMASAFE EMERGENCY #${id}: ${who} ${mother.phone}, week ${g.weeks}. ${labelsFor(symptoms).join(', ')}.${where} Call her now. Reply ACK ${id} when you act.`,
      'alert-facility');
    notified = true;
    db.prepare('UPDATE alerts SET notified = 1 WHERE id = ?').run(id);
  }
  if (mother.contact_phone) {
    sms.send(db, mother.contact_phone,
      `MamaSafe: ${who} (${mother.phone}) may need urgent help. Please check on her${facility ? ` and help her get to ${facility.name}` : ''}.`,
      'alert-contact');
  }
  const call = facility ? facilities.bestPhone(facility) : null;
  let msg;
  if (facility && notified) msg = `MamaSafe: ALERT SENT. ${facility.name} has been told. Go there now if you can.`;
  else if (facility) msg = `MamaSafe: go to ${facility.name} now${call ? ', tel ' + local(call) : ''}. We could not message them, so please call.`;
  else msg = 'MamaSafe: go to the nearest health facility now.';
  sms.send(db, mother.phone, `${msg} Call ${config.emergencyNumber} if worse.`, 'alert-mother');

  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  return { alert: shape(row), facility, notified, duplicate: false };
}

function shape(row) {
  return { ...row, symptoms: JSON.parse(row.symptoms) };
}

function acknowledge(db, id, by) {
  const r = db
    .prepare("UPDATE alerts SET status = 'acknowledged', ack_at = ?, ack_by = ? WHERE id = ? AND status = 'new'")
    .run(new Date().toISOString(), by, id);
  return r.changes > 0;
}

// Alerts joined with mother and facility details for the dashboard.
function listForDashboard(db, { status, facilityId, limit = 100 } = {}) {
  const where = [], args = [];
  if (status) { where.push('a.status = ?'); args.push(status); }
  if (facilityId) { where.push('a.facility_id = ?'); args.push(facilityId); }
  const rows = db.prepare(`
    SELECT a.*, m.name AS mother_name, m.phone AS mother_phone, m.lmp AS lmp, m.contact_phone AS contact_phone,
           f.name AS facility_name, f.area AS facility_area, f.phone AS facility_phone, f.emergency_phone AS facility_emergency_phone, f.toll_free AS facility_toll_free
    FROM alerts a JOIN mothers m ON m.id = a.mother_id LEFT JOIN facilities f ON f.id = a.facility_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (a.status = 'new') DESC, a.id DESC LIMIT ?`).all(...args, limit);
  return rows.map((r) => ({ ...shape(r), weeks: schedule.gestation(r.lmp).weeks, symptomLabels: labelsFor(JSON.parse(r.symptoms)) }));
}

module.exports = { createAlert, acknowledge, listForDashboard, chooseFacility };

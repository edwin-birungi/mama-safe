'use strict';
// A question a mother could not get answered by the assistant, handed to her clinic.
const facilities = require('./facilities');
const sms = require('./sms');
const demo = require('./demo');
const schedule = require('./schedule');

function create(db, mother, text) {
  const t = String(text || '').trim().slice(0, 300);
  if (t.length < 3) { const e = new Error('Type your question first.'); e.status = 400; throw e; }
  // Three open questions at a time, so nobody floods a clinic.
  const open = db.prepare("SELECT COUNT(*) AS n FROM questions WHERE mother_id = ? AND status = 'new'").get(mother.id).n;
  if (open >= 3) { const e = new Error('You already have questions waiting for your clinic. Please call them if it is urgent.'); e.status = 429; throw e; }
  const facility = mother.facility_id ? facilities.byId(db, mother.facility_id) : null;
  const now = new Date().toISOString();
  const { lastInsertRowid } = db.prepare('INSERT INTO questions (mother_id, facility_id, text, created_at) VALUES (?,?,?,?)')
    .run(mother.id, facility ? facility.id : null, t, now);
  const id = Number(lastInsertRowid);
  let notified = false;
  // Demo accounts are stored nowhere real and never page a clinic.
  if (demo.isDemoPhone(mother.phone)) { db.prepare('DELETE FROM questions WHERE id = ?').run(id); return { id, notified: false, demo: true, facility }; }
  if (facility && facility.alert_phone) {
    const g = schedule.gestation(mother.lmp);
    sms.send(db, facility.alert_phone, `MAMASAFE QUESTION #${id} from ${mother.name || 'a mother'} ${mother.phone}, week ${g.weeks}: "${t.slice(0, 110)}". Please call or text her back.`, 'question-facility');
    notified = true;
    db.prepare('UPDATE questions SET notified = 1 WHERE id = ?').run(id);
  }
  return { id, notified, facility };
}

function list(db, { status = 'new', facilityId, limit = 100 } = {}) {
  const where = [], args = [];
  if (status) { where.push('q.status = ?'); args.push(status); }
  if (facilityId) { where.push('q.facility_id = ?'); args.push(Number(facilityId)); }
  return db.prepare(`SELECT q.id, q.text, q.status, q.notified, q.created_at, q.handled_at, m.name AS mother_name, m.phone AS mother_phone, f.name AS facility_name
    FROM questions q JOIN mothers m ON m.id = q.mother_id LEFT JOIN facilities f ON f.id = q.facility_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY q.id DESC LIMIT ?`).all(...args, limit);
}

function handle(db, id) {
  return db.prepare("UPDATE questions SET status = 'handled', handled_at = ? WHERE id = ? AND status = 'new'").run(new Date().toISOString(), id).changes > 0;
}

module.exports = { create, list, handle };

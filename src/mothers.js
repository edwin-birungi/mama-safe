'use strict';

function create(db, { phone, name, lmp, facilityId, contactPhone, smsOptin = true, channel }) {
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO mothers (phone, name, lmp, facility_id, contact_phone, sms_optin, channel, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(phone, name || null, lmp, facilityId || null, contactPhone || null, smsOptin ? 1 : 0, channel, new Date().toISOString());
  return byId(db, Number(lastInsertRowid));
}

const clean = (r) => (r ? { ...r, sms_optin: !!r.sms_optin } : null);
const byId = (db, id) => clean(db.prepare('SELECT * FROM mothers WHERE id = ?').get(id));
const byPhone = (db, phone) => clean(db.prepare('SELECT * FROM mothers WHERE phone = ?').get(phone));

function update(db, id, fields) {
  const cols = { name: 'name', facilityId: 'facility_id', contactPhone: 'contact_phone', smsOptin: 'sms_optin', lmp: 'lmp', contactVerifiedAt: 'contact_verified_at' };
  // A new emergency contact has not agreed yet: drop the old confirmation.
  if (fields.contactPhone !== undefined) {
    const cur = byId(db, id);
    if (cur && cur.contact_phone !== fields.contactPhone) fields = { ...fields, contactVerifiedAt: null };
  }
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(cols)) {
    if (fields[k] === undefined) continue;
    sets.push(`${col} = ?`);
    vals.push(k === 'smsOptin' ? (fields[k] ? 1 : 0) : fields[k]);
  }
  if (sets.length) db.prepare(`UPDATE mothers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return byId(db, id);
}

module.exports = { create, byId, byPhone, update };

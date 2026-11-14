'use strict';
// Emergency-contact confirmation. A mother enters someone's number; we text THAT number a one-time
// code. She types the code in, which proves the number is real and the person agreed to be alerted.
// Same safeguards as the sign-in code: hashed, expires in 10 minutes, 5 wrong tries, 3 codes per hour.
const crypto = require('crypto');
const sms = require('./sms');
const demo = require('./demo');
const mothersSvc = require('./mothers');
const { local } = require('./phone');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HOUR = 3600000;
const hashFor = (motherId, phone, code) => sha(`contact:${motherId}:${phone}:${String(code).trim()}`);

function requestCode(db, mother, now = Date.now()) {
  if (!mother.contact_phone) return { error: 'Add an emergency contact number first.' };
  if (mother.contact_verified_at) return { error: 'Your emergency contact is already confirmed.' };
  const row = db.prepare('SELECT * FROM contact_codes WHERE mother_id = ?').get(mother.id);
  const inWindow = row && now - row.window_start < HOUR;
  if (inWindow && row.sent_count >= 3) return { error: 'Too many codes sent. Try again in an hour.', limited: true };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare(`INSERT INTO contact_codes (mother_id, phone, code_hash, expires_at, attempts, sent_count, window_start) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(mother_id) DO UPDATE SET phone = excluded.phone, code_hash = excluded.code_hash, expires_at = excluded.expires_at,
              attempts = 0, sent_count = excluded.sent_count, window_start = excluded.window_start`)
    .run(mother.id, mother.contact_phone, hashFor(mother.id, mother.contact_phone, code), now + 10 * 60000, 0, inWindow ? row.sent_count + 1 : 1, inWindow ? row.window_start : now);
  if (demo.isDemoPhone(mother.phone)) return { ok: true, code, to: mother.contact_phone, smsId: null, demo: true }; // never text a number a tester typed
  const who = mother.name ? `${mother.name} (${local(mother.phone)})` : local(mother.phone);
  // kind 'otp' so the code is wiped from the outbox once the SMS is delivered.
  const smsId = sms.send(db, mother.contact_phone,
    `MamaSafe: ${who} wants to list you as her emergency contact. If you agree, give her this code: ${code}. It expires in 10 minutes. If you do not know her, ignore this message.`, 'otp');
  return { ok: true, code, to: mother.contact_phone, smsId };
}

function verifyCode(db, mother, code, now = Date.now()) {
  if (!mother.contact_phone) return { error: 'Add an emergency contact number first.' };
  if (mother.contact_verified_at) return { ok: true, already: true };
  const row = db.prepare('SELECT * FROM contact_codes WHERE mother_id = ?').get(mother.id);
  // A code for an older number is useless once she has changed the contact.
  if (!row || row.phone !== mother.contact_phone || now > row.expires_at) return { error: 'Code expired. Ask for a new one.' };
  if (row.attempts >= 5) return { error: 'Too many wrong tries. Ask for a new code.' };
  const given = Buffer.from(hashFor(mother.id, mother.contact_phone, code));
  const want = Buffer.from(row.code_hash);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    db.prepare('UPDATE contact_codes SET attempts = attempts + 1 WHERE mother_id = ?').run(mother.id);
    return { error: 'Wrong code.' };
  }
  db.prepare('DELETE FROM contact_codes WHERE mother_id = ?').run(mother.id);
  mothersSvc.update(db, mother.id, { contactVerifiedAt: new Date(now).toISOString() });
  return { ok: true };
}

module.exports = { requestCode, verifyCode };

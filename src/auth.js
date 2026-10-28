'use strict';
const crypto = require('crypto');
const sms = require('./sms');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HOUR = 3600000;
const TOKEN_TTL = 90 * 24 * HOUR;

// One-time codes prove the web user owns the phone number, so nobody can register someone
// else's number and trigger SMS to it. (USSD and SMS prove it already: the network tells us.)
function requestOtp(db, phone, now = Date.now()) {
  const row = db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);
  const inWindow = row && now - row.window_start < HOUR;
  if (inWindow && row.sent_count >= 3) return { error: 'Too many codes requested. Try again in an hour.' };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare(`INSERT INTO otps (phone, code_hash, expires_at, attempts, sent_count, window_start) VALUES (?,?,?,?,?,?)
              ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
              attempts = 0, sent_count = excluded.sent_count, window_start = excluded.window_start`)
    .run(phone, sha(phone + ':' + code), now + 10 * 60000, 0, inWindow ? row.sent_count + 1 : 1, inWindow ? row.window_start : now);
  sms.send(db, phone, `MamaSafe code: ${code}. It expires in 10 minutes. Do not share it.`, 'otp');
  return { ok: true, code };
}

function verifyOtp(db, phone, code, now = Date.now()) {
  const row = db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);
  if (!row || now > row.expires_at) return { error: 'Code expired. Request a new one.' };
  if (row.attempts >= 5) return { error: 'Too many wrong attempts. Request a new code.' };
  const given = Buffer.from(sha(phone + ':' + String(code).trim()));
  const want = Buffer.from(row.code_hash);
  if (!crypto.timingSafeEqual(given, want)) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    return { error: 'Wrong code.' };
  }
  db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO tokens (token_hash, phone, created_at) VALUES (?,?,?)').run(sha(token), phone, new Date(now).toISOString());
  return { token };
}

// Returns the phone number the bearer token belongs to, or null.
function phoneForToken(db, token, now = Date.now()) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM tokens WHERE token_hash = ?').get(sha(token));
  if (!row) return null;
  if (now - Date.parse(row.created_at) > TOKEN_TTL) return null;
  return row.phone;
}

function safeEqual(a, b) {
  const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b)));
  return crypto.timingSafeEqual(x, y);
}

module.exports = { requestOtp, verifyOtp, phoneForToken, safeEqual };

'use strict';
const crypto = require('crypto');
const sms = require('./sms');
const demo = require('./demo');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HOUR = 3600000;
const TOKEN_TTL = 90 * 24 * HOUR;
const PASSWORD_MIN = 8;
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function passwordMatches(password, encoded) {
  const [scheme, salt64, hash64] = String(encoded || '').split('$');
  if (scheme !== 'scrypt' || !salt64 || !hash64) return false;
  const salt = Buffer.from(salt64, 'base64url');
  const expected = Buffer.from(hash64, 'base64url');
  if (!salt.length || !expected.length) return false;
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function makeRecoveryCode() {
  const raw = [...crypto.randomBytes(20)].map((n) => RECOVERY_ALPHABET[n % RECOVERY_ALPHABET.length]).join('');
  return raw.match(/.{1,4}/g).join('-');
}

function recoveryHash(code) {
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function registerPassword(db, { phone, email = null, password }, now = Date.now()) {
  const p = String(password || '');
  if (p.length < PASSWORD_MIN || p.length > 128) return { error: `Choose a password between ${PASSWORD_MIN} and 128 characters.`, status: 400 };
  if (db.prepare('SELECT phone FROM accounts WHERE phone = ?').get(phone)) return { error: 'An account already uses this phone. Sign in instead.', status: 409 };
  if (email && db.prepare('SELECT phone FROM accounts WHERE email = ? COLLATE NOCASE').get(email)) return { error: 'An account already uses this email. Sign in instead.', status: 409 };
  // A mother may already have a profile from the older OTP/USSD flow. Let her
  // attach a password account to that same phone; the registration route will
  // recognize the existing profile and take her straight to Home.
  const code = makeRecoveryCode();
  db.prepare('INSERT INTO accounts (phone, email, password_hash, recovery_hash, created_at) VALUES (?,?,?,?,?)')
    .run(phone, email || null, passwordHash(p), recoveryHash(code), new Date(now).toISOString());
  return { ...issueToken(db, phone, now), recoveryCode: code };
}

function loginPassword(db, { identifier, password }, now = Date.now()) {
  const p = String(password || '');
  if (p.length < PASSWORD_MIN || p.length > 128) return { error: 'Phone/email or password is incorrect.', status: 401 };
  const account = db.prepare('SELECT * FROM accounts WHERE phone = ? OR email = ? COLLATE NOCASE').get(identifier, identifier);
  if (!account || !passwordMatches(p, account.password_hash)) return { error: 'Phone/email or password is incorrect.', status: 401 };
  return issueToken(db, account.phone, now);
}

function setPassword(db, { phone, email, password }) {
  const p = String(password || '');
  if (p.length < PASSWORD_MIN || p.length > 128) return { error: `Choose a password between ${PASSWORD_MIN} and 128 characters.`, status: 400 };
  if (email) {
    const owner = db.prepare('SELECT phone FROM accounts WHERE email = ? COLLATE NOCASE').get(email);
    if (owner && owner.phone !== phone) return { error: 'That email is already linked to another account.', status: 409 };
  }
  const existing = db.prepare('SELECT phone FROM accounts WHERE phone = ?').get(phone);
  const code = makeRecoveryCode();
  if (existing) {
    if (email === undefined) db.prepare('UPDATE accounts SET password_hash = ?, recovery_hash = ? WHERE phone = ?').run(passwordHash(p), recoveryHash(code), phone);
    else db.prepare('UPDATE accounts SET email = ?, password_hash = ?, recovery_hash = ? WHERE phone = ?').run(email || null, passwordHash(p), recoveryHash(code), phone);
  } else {
    db.prepare('INSERT INTO accounts (phone, email, password_hash, recovery_hash, created_at) VALUES (?,?,?,?,?)')
      .run(phone, email || null, passwordHash(p), recoveryHash(code), new Date().toISOString());
  }
  return { ok: true, recoveryCode: code };
}

function recoverPassword(db, { identifier, recoveryCode, password }) {
  const p = String(password || '');
  if (p.length < PASSWORD_MIN || p.length > 128) return { error: `Choose a password between ${PASSWORD_MIN} and 128 characters.`, status: 400 };
  const account = db.prepare('SELECT * FROM accounts WHERE phone = ? OR email = ? COLLATE NOCASE').get(identifier, identifier);
  const supplied = Buffer.from(recoveryHash(recoveryCode));
  const expected = Buffer.from(account && account.recovery_hash || '0'.repeat(64));
  if (!account || !account.recovery_hash || !crypto.timingSafeEqual(supplied, expected)) return { error: 'The account details or recovery code do not match.', status: 400 };
  const code = makeRecoveryCode();
  const changed = db.prepare('UPDATE accounts SET password_hash = ?, recovery_hash = ? WHERE phone = ? AND recovery_hash = ?')
    .run(passwordHash(p), recoveryHash(code), account.phone, account.recovery_hash).changes;
  if (!changed) return { error: 'The account details or recovery code do not match.', status: 400 };
  return { ok: true, recoveryCode: code };
}

// One-time codes prove the web user owns the phone number, so nobody can register someone
// else's number and trigger SMS to it. (USSD and SMS prove it already: the network tells us.)
function requestOtp(db, phone, now = Date.now()) {
  // Demo numbers sign in with the developer access code instead of an SMS.
  if (demo.isDemoPhone(phone)) return { ok: true, demo: true, code: null, smsId: null };
  const row = db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);
  const inWindow = row && now - row.window_start < HOUR;
  if (inWindow && row.sent_count >= 3) return { error: 'Too many codes requested. Try again in an hour.' };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare(`INSERT INTO otps (phone, code_hash, expires_at, attempts, sent_count, window_start) VALUES (?,?,?,?,?,?)
              ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
              attempts = 0, sent_count = excluded.sent_count, window_start = excluded.window_start`)
    .run(phone, sha(phone + ':' + code), now + 10 * 60000, 0, inWindow ? row.sent_count + 1 : 1, inWindow ? row.window_start : now);
  const smsId = sms.send(db, phone, `MamaSafe code: ${code}. It expires in 10 minutes. Do not share it.`, 'otp');
  return { ok: true, code, smsId };
}

function issueToken(db, phone, now) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO tokens (token_hash, phone, created_at) VALUES (?,?,?)').run(sha(token), phone, new Date(now).toISOString());
  return { token };
}

function verifyOtp(db, phone, code, now = Date.now()) {
  if (demo.isDemoPhone(phone)) {
    const c = demo.check(phone, code, now);
    return c.ok ? issueToken(db, phone, now) : c;
  }
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
  return issueToken(db, phone, now);
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

module.exports = { requestOtp, verifyOtp, phoneForToken, safeEqual, registerPassword, loginPassword, setPassword, recoverPassword, PASSWORD_MIN };

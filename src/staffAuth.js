'use strict';
const crypto = require('crypto');

// Keep staff signed in across routine browser restarts; logout revokes the token immediately.
const SESSION_TTL = 90 * 24 * 60 * 60 * 1000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function passwordMatches(password, encoded) {
  const [scheme, salt64, hash64] = String(encoded || '').split('$');
  if (scheme !== 'scrypt' || !salt64 || !hash64) return false;
  const salt = Buffer.from(salt64, 'base64url'), expected = Buffer.from(hash64, 'base64url');
  if (!salt.length || !expected.length) return false;
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function issueSession(db, { staffId = null, legacyUser = null }, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO staff_sessions (token_hash, staff_id, legacy_user, created_at) VALUES (?,?,?,?)')
    .run(sha(token), staffId, legacyUser, new Date(now).toISOString());
  return token;
}

function register(db, { name, email, password }, now = Date.now()) {
  if (password.length < 8 || password.length > 128) throw Object.assign(new Error('Choose a password between 8 and 128 characters.'), { status: 400 });
  if (db.prepare('SELECT id FROM staff_accounts WHERE email = ? COLLATE NOCASE').get(email)) {
    throw Object.assign(new Error('An account already uses this email. Sign in instead.'), { status: 409 });
  }
  const result = db.prepare('INSERT INTO staff_accounts (email, name, password_hash, created_at) VALUES (?,?,?,?)')
    .run(email, name, passwordHash(password), new Date(now).toISOString());
  const id = Number(result.lastInsertRowid);
  return {
    token: issueSession(db, { staffId: id }, now),
    staff: { id, email, name }
  };
}

function login(db, { email, password }, now = Date.now()) {
  const account = db.prepare('SELECT * FROM staff_accounts WHERE email = ? COLLATE NOCASE AND active = 1').get(email);
  if (!account || !passwordMatches(password, account.password_hash)) return null;
  return {
    token: issueSession(db, { staffId: account.id }, now),
    staff: { id: account.id, email: account.email, name: account.name }
  };
}

function current(db, token, now = Date.now()) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM staff_sessions WHERE token_hash = ?').get(sha(token));
  if (!session) return null;
  if (now - Date.parse(session.created_at) > SESSION_TTL) {
    db.prepare('DELETE FROM staff_sessions WHERE token_hash = ?').run(session.token_hash);
    return null;
  }
  if (session.staff_id != null) {
    const staff = db.prepare('SELECT id, email, name FROM staff_accounts WHERE id = ? AND active = 1').get(session.staff_id);
    return staff ? { ...staff, legacy: false } : null;
  }
  return session.legacy_user ? { id: null, email: null, name: session.legacy_user, legacy: true } : null;
}

function logout(db, token) {
  if (!token) return false;
  return db.prepare('DELETE FROM staff_sessions WHERE token_hash = ?').run(sha(token)).changes > 0;
}

module.exports = { register, login, current, issueSession, logout };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const staffAuth = require('../src/staffAuth');
const { freshDb, isoAgo } = require('./helpers');

async function start() {
  const db = freshDb();
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    db,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const json = (base, path, { method = 'GET', body, token } = {}) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

test('mother account can register, complete a profile, and return by email or phone sign-in', async (t) => {
  const { base, close } = await start();
  t.after(close);

  const created = await json(base, '/api/account/register', {
    method: 'POST', body: { phone: '0712 345 678', email: 'amina@example.org', password: 'mother-pass-123' }
  });
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^[a-f0-9]{64}$/);
  assert.match(created.body.recoveryCode, /^[A-Z0-9-]+$/);
  assert.equal(created.body.registered, false);
  assert.equal((await json(base, '/api/me', { token: created.body.token })).body.registered, false);

  const profile = await json(base, '/api/register', {
    method: 'POST', token: created.body.token,
    body: { name: 'Amina Nansubuga', lmp: isoAgo(168), facilityId: 1, contactPhone: '0700111222' }
  });
  assert.equal(profile.status, 201);
  assert.equal(profile.body.mother.contactVerified, false);
  const contactCode = await json(base, '/api/contact/request', { method: 'POST', token: created.body.token });
  assert.equal(contactCode.status, 200);
  const confirmed = await json(base, '/api/contact/verify', {
    method: 'POST', token: created.body.token, body: { code: contactCode.body.devCode }
  });
  assert.equal(confirmed.body.mother.contactVerified, true);

  for (const identifier of ['amina@example.org', '0712345678']) {
    const login = await json(base, '/api/account/login', {
      method: 'POST', body: { identifier, password: 'mother-pass-123' }
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.registered, true);
    const me = await json(base, '/api/me', { token: login.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.mother.name, 'Amina Nansubuga');
  }

  assert.equal((await json(base, '/api/account/login', {
    method: 'POST', body: { identifier: 'amina@example.org', password: 'wrong-password' }
  })).status, 401);
});

test('staff account can register, sign in case-insensitively, access the dashboard, and log out', async (t) => {
  const { base, close } = await start();
  t.after(close);

  const created = await json(base, '/api/admin/account/register', {
    method: 'POST', body: { name: 'Clinic Staff', email: 'staff@example.org', password: 'staff-pass-123' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.staff.name, 'Clinic Staff');
  assert.equal((await json(base, '/api/admin/session', { token: created.body.token })).status, 200);

  const login = await json(base, '/api/admin/account/login', {
    method: 'POST', body: { identifier: 'STAFF@example.org', password: 'staff-pass-123' }
  });
  assert.equal(login.status, 200);
  assert.equal((await json(base, '/api/admin/session', { token: login.body.token })).body.staff.email, 'staff@example.org');
  assert.equal((await json(base, '/api/admin/account/login', {
    method: 'POST', body: { identifier: 'staff@example.org', password: 'wrong-password' }
  })).status, 401);
  assert.equal((await json(base, '/api/admin/account/logout', { method: 'POST', token: login.body.token })).status, 200);
  assert.equal((await json(base, '/api/admin/session', { token: login.body.token })).status, 401);
});

test('staff sessions stay valid across browser returns and expire after 90 days', () => {
  const db = freshDb();
  const createdAt = Date.UTC(2026, 0, 1);
  const session = staffAuth.register(db, {
    name: 'Clinic Staff', email: 'staff@example.org', password: 'staff-pass-123'
  }, createdAt);
  assert.equal(staffAuth.current(db, session.token, createdAt + 24 * 60 * 60 * 1000).name, 'Clinic Staff');
  assert.equal(staffAuth.current(db, session.token, createdAt + 90 * 24 * 60 * 60 * 1000 + 1), null);
});

test('an account can be created and used without SMS verification', async (t) => {
  const { base, db, close } = await start();
  t.after(close);
  const body = { phone: '0712345678', password: 'mother-pass-123' };
  const created = await json(base, '/api/account/register', { method: 'POST', body });
  assert.equal(created.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 1);
  const login = await json(base, '/api/account/login', {
    method: 'POST', body: { identifier: '0712345678', password: 'mother-pass-123' }
  });
  assert.equal(login.status, 200);
  assert.match(login.body.token, /^[a-f0-9]{64}$/);
});

test('a phone with an existing care profile can create a password account without SMS verification', async (t) => {
  const { base, db, close } = await start();
  t.after(close);
  require('../src/mothers').create(db, { phone: '+256712345678', name: 'Amina Nansubuga', lmp: isoAgo(168), facilityId: 1, channel: 'app' });
  const created = await json(base, '/api/account/register', { method: 'POST', body: { phone: '0712345678', password: 'mother-pass-123' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.registered, true);
  const login = await json(base, '/api/account/login', { method: 'POST', body: { identifier: '0712345678', password: 'mother-pass-123' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.registered, true);
});

test('registering needs no emergency contact; the profile then shows it is still to be added', async (t) => {
  const { base, close } = await start();
  t.after(close);
  const created = await json(base, '/api/account/register', { method: 'POST', body: { phone: '0712345678', password: 'mother-pass-123' } });
  const reg = await json(base, '/api/register', { method: 'POST', token: created.body.token, body: { name: 'Amina Nansubuga', lmp: isoAgo(168), facilityId: 1 } });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.mother.contactPhone, null);
  assert.equal(reg.body.mother.contactVerified, false);
  const later = await json(base, '/api/me', { method: 'PATCH', token: created.body.token, body: { contactPhone: '0700111222' } });
  assert.equal(later.body.mother.contactPhone, '+256700111222');
});

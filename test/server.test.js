'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const staffAuth = require('../src/staffAuth');
const { freshDb, isoAgo, outbox } = require('./helpers');

async function start() {
  const db = freshDb();
  const staffToken = staffAuth.register(db, { name: 'Test Staff', email: 'staff@example.org', password: 'staff-pass-123' }).token;
  const server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, staffToken, close: () => new Promise((r) => server.close(r)) };
}

const json = (base, path, { method = 'GET', body, token } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('web journey: OTP sign-in, register, profile, alert, dashboard acknowledge', async (t) => {
  const { db, base, staffToken, close } = await start();
  t.after(close);

  // Cannot do anything signed out.
  assert.equal((await json(base, '/api/me')).status, 401);

  // Sign in with a code.
  const req = await json(base, '/api/otp/request', { method: 'POST', body: { phone: '0712 345 678' } });
  assert.equal(req.status, 200);
  assert.equal(req.body.phone, '+256712345678');
  assert.match(req.body.devCode, /^\d{6}$/);
  assert.equal(outbox(db).filter((o) => o.kind === 'otp').length, 1);

  const wrong = await json(base, '/api/otp/verify', { method: 'POST', body: { phone: '0712345678', code: '000000' === req.body.devCode ? '111111' : '000000' } });
  assert.equal(wrong.status, 400);
  const ok = await json(base, '/api/otp/verify', { method: 'POST', body: { phone: '0712345678', code: req.body.devCode } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.registered, false);
  const token = ok.body.token;
  assert.equal((await json(base, '/api/otp/verify', { method: 'POST', body: { phone: '0712345678', code: req.body.devCode } })).status, 400); // single use

  assert.deepEqual((await json(base, '/api/me', { token })).body, {
    registered: false, phone: '+256712345678',
    account: { passwordSet: false, emailSet: false, recoverySet: false }
  });

  // Alerts need a profile first.
  assert.equal((await json(base, '/api/alerts', { method: 'POST', token, body: { symptoms: ['bleeding'] } })).status, 404);

  // Validation.
  const badDate = await json(base, '/api/register', { method: 'POST', token, body: { name: 'Amina Nansubuga', lmp: '2020-01-01' } });
  assert.equal(badDate.status, 400);
  const missingSurname = await json(base, '/api/register', { method: 'POST', token, body: { name: 'Amina', lmp: isoAgo(100) } });
  assert.equal(missingSurname.status, 400);
  assert.match(missingSurname.body.error, /full name/i);
  const badContact = await json(base, '/api/register', { method: 'POST', token, body: { name: 'Amina Nansubuga', lmp: isoAgo(100), contactPhone: '12' } });
  assert.equal(badContact.status, 400);

  // Register.
  const reg = await json(base, '/api/register', { method: 'POST', token, body: { name: 'Amina Nansubuga', lmp: isoAgo(168), facilityId: 1, contactPhone: '0700111222' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.gestation.weeks, 24);
  assert.equal(reg.body.visits.length, 8);
  assert.equal(reg.body.next.no, 3);
  assert.equal(reg.body.mother.contactPhone, '+256700111222');
  assert.equal((await json(base, '/api/register', { method: 'POST', token, body: { lmp: isoAgo(100) } })).status, 409);

  // Not an emergency => refused. Emergency with GPS => nearest 24h facility.
  assert.equal((await json(base, '/api/alerts', { method: 'POST', token, body: { symptoms: ['mild'] } })).status, 400);
  const al = await json(base, '/api/alerts', { method: 'POST', token, body: { symptoms: ['bleeding', 'swelling'], lat: 0.4201, lng: 32.6549 } });
  assert.equal(al.status, 201);
  assert.match(al.body.facility.name, /Health Centre IV \(Area B\)/);
  assert.equal((await json(base, '/api/alerts', { method: 'POST', token, body: { symptoms: ['sos'], lat: 999, lng: 0 } })).status, 400);

  // Dashboard sees it and can acknowledge it.
  const list = await json(base, '/api/admin/alerts', { token: staffToken });
  assert.equal(list.body.alerts.length, 1);
  assert.equal(list.body.alerts[0].mother_name, 'Amina Nansubuga');
  assert.deepEqual(list.body.alerts[0].symptomLabels, ['Heavy vaginal bleeding', 'Swollen face or hands']);
  assert.equal(list.body.alerts[0].weeks, 24);
  const id = list.body.alerts[0].id;
  assert.equal((await json(base, `/api/admin/alerts/${id}/ack`, { method: 'POST', token: staffToken })).status, 200);
  assert.equal((await json(base, `/api/admin/alerts/${id}/ack`, { method: 'POST', token: staffToken })).status, 404);
  assert.equal((await json(base, '/api/admin/alerts?status=new', { token: staffToken })).body.alerts.length, 0);
});

test('OTP requests are limited per phone', async (t) => {
  const { base, close } = await start();
  t.after(close);
  for (let i = 0; i < 3; i++) assert.equal((await json(base, '/api/otp/request', { method: 'POST', body: { phone: '0712345678' } })).status, 200);
  assert.equal((await json(base, '/api/otp/request', { method: 'POST', body: { phone: '0712345678' } })).status, 429);
});

test('USSD and SMS webhooks accept gateway-style form posts', async (t) => {
  const { db, base, close } = await start();
  t.after(close);
  const form = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) })
    .then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), text: await r.text() }));

  const u = await form('/ussd', { sessionId: 'x', serviceCode: '*123#', phoneNumber: '+256712345678', text: '' });
  assert.equal(u.status, 200);
  assert.match(u.type, /text\/plain/);
  assert.match(u.text, /^CON Welcome to MamaSafe/);

  const r = await form('/sms/inbound', { from: '+256712345678', to: '1234', text: 'HELP' });
  assert.equal(r.status, 200);
  const reply = outbox(db).find((o) => o.kind === 'reply');
  assert.equal(reply.to_phone, '+256712345678');
  assert.match(reply.body, /To register text REG/);
});

test('static files, health check and path traversal', async (t) => {
  const { base, close } = await start();
  t.after(close);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await fetch(base + '/dashboard')).status, 200);
  assert.equal((await json(base, '/healthz')).body.ok, true);
  assert.equal((await fetch(base + '/%2e%2e/%2e%2e/package.json')).status, 404);
  assert.equal((await fetch(base + '/nope')).status, 404);
  const csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
});

test('facility finder API: nearest first, filters, paging, and private fields never leak', async (t) => {
  const { db, base, close } = await start();
  t.after(close);
  db.prepare("UPDATE facilities SET toll_free='+256800100036', notes='internal' WHERE code='SHOSP'").run();

  const near = await json(base, '/api/facilities?lat=0.3476&lng=32.5825&limit=2');
  assert.equal(near.status, 200);
  assert.equal(near.body.total, 6);
  assert.equal(near.body.facilities.length, 2);
  assert.equal(near.body.facilities[0].code, 'SHC3A');
  assert.ok(near.body.facilities[0].distanceKm < 0.1);
  for (const f of near.body.facilities) { assert.ok(!('alert_phone' in f)); assert.ok(!('notes' in f)); }

  const hosp = await json(base, '/api/facilities?kind=hospital');
  assert.deepEqual(hosp.body.facilities.map((f) => f.code), ['SHOSP']);
  assert.equal(hosp.body.facilities[0].toll_free, '+256800100036');
  assert.equal((await json(base, '/api/facilities?q=area%20b')).body.total, 2);
  assert.equal((await json(base, '/api/facilities?open24=1')).body.facilities.every((f) => f.open24 === true), true);
  assert.equal((await json(base, '/api/facilities?lat=abc&lng=1')).status, 400);
  assert.equal((await json(base, '/api/facilities?lat=95&lng=1')).status, 400);
});

test('config exposes helplines and the maps key; the admin can set a facility alert mobile', async (t) => {
  const { db, base, staffToken, close } = await start();
  t.after(close);
  const c = await json(base, '/api/config');
  assert.ok(c.body.helplines.some((l) => l.number === '999'));
  assert.equal(typeof c.body.googleMapsKey, 'string');
  const id = db.prepare("SELECT id FROM facilities WHERE code = 'SCLA'").get().id;
  const bad = await json(base, `/api/admin/facilities/${id}`, { method: 'PATCH', token: staffToken, body: { alert_phone: 'abc' } });
  assert.equal(bad.status, 400);
  const ok = await json(base, `/api/admin/facilities/${id}`, { method: 'PATCH', token: staffToken, body: { alert_phone: '0777 123 456' } });
  assert.equal(ok.status, 200);
  assert.equal(db.prepare('SELECT alert_phone FROM facilities WHERE id = ?').get(id).alert_phone, '+256777123456');
});

test('curated Uganda list loads cleanly and every number is well formed', () => {
  const path = require('path');
  const { open } = require('../src/db');
  const { importCsv } = require('../src/importFacilities');
  const { isTollFree } = require('../src/phone');
  const db = open(':memory:');
  const r = importCsv(db, path.join(__dirname, '..', 'seed', 'facilities.uganda.csv'));
  assert.equal(r.skipped.length, 0);
  assert.ok(r.imported >= 20);
  for (const f of db.prepare('SELECT * FROM facilities').all()) {
    assert.ok(f.lat > -2 && f.lat < 5 && f.lng > 28 && f.lng < 36, `${f.code} coordinates inside Uganda`);
    for (const k of ['phone', 'emergency_phone', 'toll_free']) if (f[k]) assert.match(f[k], /^\+256\d{9}$/, `${f.code} ${k}`);
    if (f.toll_free) assert.ok(isTollFree(f.toll_free), `${f.code} toll_free is 0800/0801`);
    if (f.phone) assert.ok(!isTollFree(f.phone), `${f.code} phone should not be toll-free`);
    assert.ok(f.contact_confidence, `${f.code} has a confidence flag`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM facilities WHERE alert_phone IS NOT NULL').get().n, 0); // never ship guessed staff mobiles
  // re-import is idempotent
  importCsv(db, path.join(__dirname, '..', 'seed', 'facilities.uganda.csv'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM facilities').get().n, r.imported);
});

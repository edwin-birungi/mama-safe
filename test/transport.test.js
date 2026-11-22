'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createServer } = require('../src/server');
const transport = require('../src/transport');
const { importCsv } = require('../src/importTransport');
const mothers = require('../src/mothers');
const alerts = require('../src/alerts');
const auth = require('../src/auth');
const staffAuth = require('../src/staffAuth');
const ussd = require('../src/ussd');
const smsCommands = require('../src/smsCommands');
const { freshDb, isoAgo, outbox } = require('./helpers');

const PHONE = '+256712345678';
const FIXTURE = path.join(__dirname, 'fixtures', 'transport.sample.csv');
// Near boda rider 1; the ambulance is ~3.6 km away, the taxi ~2.5 km, the Area B boda is outside its 8 km radius.
const AT = { lat: 0.348, lng: 32.583 };
const AMBULANCE = '+256700000101', BODA1 = '+256700000102', TAXI = '+256700000103', BODA_B = '+256700000104', VOLUNTEER = '+256700000105';

function setup() {
  const db = freshDb();
  const imp = importCsv(db, FIXTURE);
  const mother = mothers.create(db, { phone: PHONE, name: 'Amina', lmp: isoAgo(168), facilityId: 1, contactPhone: '+256700111222', channel: 'app' });
  return { db, mother, imp };
}
const sent = (db, kind) => outbox(db).filter((o) => o.kind === kind);

test('CSV import adds drivers, is safe to re-run, and reports bad rows', () => {
  const { db, imp } = setup();
  assert.equal(imp.imported, 5);
  assert.deepEqual(imp.skipped, []);
  const again = importCsv(db, FIXTURE);
  assert.equal(again.imported, 0);
  assert.equal(again.updated, 5);
  assert.equal(transport.listAll(db).length, 5);
  assert.equal(transport.byPhone(db, AMBULANCE).facility_id, 4); // linked by facility code SHOSP
});

test('nearby: sorted by distance, honours each driver radius, skips busy and inactive drivers', () => {
  const { db } = setup();
  const list = transport.nearby(db, { ...AT, area: 'Sample Area A' });
  assert.deepEqual(list.map((p) => p.phone), [BODA1, TAXI, AMBULANCE, VOLUNTEER]);
  assert.ok(list[0].distanceKm < list[1].distanceKm && list[1].distanceKm < list[2].distanceKm);
  assert.ok(!list.some((p) => p.phone === BODA_B), 'Area B boda is outside its 8 km radius');
  transport.setAvailable(db, transport.byPhone(db, BODA1), false);
  assert.ok(!transport.nearby(db, AT).some((p) => p.phone === BODA1));
  db.prepare('UPDATE transport_providers SET active = 0 WHERE phone = ?').run(TAXI);
  assert.ok(!transport.nearby(db, AT).some((p) => p.phone === TAXI));
});

test('nearby without GPS uses her district, ambulances first', () => {
  const { db } = setup();
  const list = transport.nearby(db, { area: 'Sample Area A' });
  assert.equal(list[0].kind, 'ambulance');
  assert.ok(list.every((p) => ['Sample Area A'].includes(p.area)));
  assert.equal(transport.nearby(db, { area: 'Nowhere' }).length, 0);
});

test('public view shows only a rounded (about 1 km) map position and never staff notes', () => {
  const { db } = setup();
  const row = transport.nearby(db, AT)[0];
  const v = transport.publicView(row);
  assert.deepEqual(Object.keys(v).sort(), ['area', 'distanceKm', 'id', 'kind', 'kindLabel', 'lat', 'lng', 'name', 'phone']);
  assert.equal(v.lat, Math.round(row.lat * 100) / 100);
  assert.equal(v.lng, Math.round(row.lng * 100) / 100);
  assert.notEqual(v.lat, row.lat, 'the exact base is never sent');
});

test('SOS with GPS asks the closest ambulance plus the nearest others, and tells the mother', () => {
  const { db, mother } = setup();
  const r = alerts.createAlert(db, { mother, symptoms: ['bleeding'], ...AT, channel: 'app' });
  assert.equal(r.transport.asked, 3);
  const asks = sent(db, 'transport-request');
  assert.deepEqual(asks.map((o) => o.to_phone).sort(), [AMBULANCE, BODA1, TAXI].sort());
  for (const o of asks) {
    assert.match(o.body, new RegExp(`GO ${r.alert.id}`));
    assert.match(o.body, /maps\.google\.com\/\?q=0\.34800,32\.58300/);
    // Privacy: drivers are not told who she is, her number, or her symptoms until one accepts.
    assert.doesNotMatch(o.body, /Amina|712345678|bleeding/i);
  }
  const toMother = sent(db, 'alert-mother')[0].body;
  assert.match(toMother, /We asked 3 nearby drivers/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transport_requests').get().n, 3);
});

test('the first driver to reply GO gets the mother number; others are told it is taken', () => {
  const { db, mother } = setup();
  const { alert } = alerts.createAlert(db, { mother, symptoms: ['sos'], ...AT, channel: 'app' });
  const first = smsCommands.handle(db, { from: '0700000102', text: `GO ${alert.id}` });
  assert.match(first, /pickup #\d+ is yours/);
  assert.match(first, /Amina 0712345678/);
  assert.match(first, /maps\.google\.com/);

  const updates = sent(db, 'transport-update');
  assert.ok(updates.some((o) => o.to_phone === PHONE && /SAMPLE Boda rider near stage 1.*is coming to you/.test(o.body)), 'mother told who is coming');
  assert.ok(updates.some((o) => o.to_phone === '+256700000002' && /transport is on the way/.test(o.body)), 'facility told');
  assert.ok(updates.some((o) => o.to_phone === '+256700111222'), 'emergency contact told');
  const taken = updates.filter((o) => /taken by another driver/.test(o.body)).map((o) => o.to_phone).sort();
  assert.deepEqual(taken, [AMBULANCE, TAXI].sort());

  const late = smsCommands.handle(db, { from: '0700000103', text: `GO ${alert.id}` });
  assert.match(late, /already taken/);
  assert.doesNotMatch(late, /0712345678/, 'a late driver never receives her number');
  assert.equal(transport.byPhone(db, BODA1).available, false, 'the driver who accepted is busy until AVAILABLE');
  const status = Object.fromEntries(db.prepare('SELECT p.phone, r.status FROM transport_requests r JOIN transport_providers p ON p.id = r.provider_id').all().map((r) => [r.phone, r.status]));
  assert.deepEqual(status, { [BODA1]: 'accepted', [AMBULANCE]: 'taken', [TAXI]: 'taken' });
});

test('GO from a number that was not asked, or from a stranger, reveals nothing', () => {
  const { db, mother } = setup();
  const { alert } = alerts.createAlert(db, { mother, symptoms: ['sos'], ...AT, channel: 'app' });
  assert.match(smsCommands.handle(db, { from: '0700000104', text: `GO ${alert.id}` }), /no pickup request/);
  const stranger = smsCommands.handle(db, { from: '0755555555', text: `GO ${alert.id}` });
  assert.doesNotMatch(stranger, /0712345678|Amina/);
  assert.match(smsCommands.handle(db, { from: '0700000102', text: 'GO' }), /text GO and the pickup number/);
  // Accepting twice is harmless.
  smsCommands.handle(db, { from: '0700000102', text: `GO ${alert.id}` });
  assert.match(smsCommands.handle(db, { from: '0700000102', text: `go ${alert.id}` }), /already yours/);
});

test('BUSY and AVAILABLE switch a driver in and out of requests', () => {
  const { db, mother } = setup();
  assert.match(smsCommands.handle(db, { from: '0700000102', text: 'busy' }), /BUSY/);
  const r = alerts.createAlert(db, { mother, symptoms: ['sos'], ...AT, channel: 'app' });
  assert.ok(!sent(db, 'transport-request').some((o) => o.to_phone === BODA1));
  assert.equal(r.transport.asked, 3);
  assert.match(smsCommands.handle(db, { from: '0700000102', text: 'AVAILABLE' }), /AVAILABLE/);
  assert.equal(transport.byPhone(db, BODA1).available, true);
});

test('no drivers listed: the alert works exactly as before', () => {
  const db = freshDb();
  const mother = mothers.create(db, { phone: PHONE, lmp: isoAgo(168), facilityId: 1, channel: 'app' });
  const r = alerts.createAlert(db, { mother, symptoms: ['sos'], ...AT, channel: 'app' });
  assert.equal(r.transport.asked, 0);
  assert.equal(sent(db, 'transport-request').length, 0);
  assert.doesNotMatch(sent(db, 'alert-mother')[0].body, /driver/);
});

test('a transport failure can never stop the alert or the mother confirmation', () => {
  const { db, mother } = setup();
  db.exec('DROP TABLE transport_requests');
  const r = alerts.createAlert(db, { mother, symptoms: ['sos'], ...AT, channel: 'app' });
  assert.ok(r.alert.id);
  assert.equal(r.transport.asked, 0);
  assert.equal(sent(db, 'alert-mother').length, 1);
  assert.equal(sent(db, 'alert-facility').length, 1);
});

test('a repeated tap does not ask drivers twice', () => {
  const { db, mother } = setup();
  const a = alerts.createAlert(db, { mother, symptoms: ['sos'], ...AT, channel: 'app' });
  const b = alerts.createAlert(db, { mother, symptoms: ['sos'], ...AT, channel: 'app' });
  assert.equal(b.duplicate, true);
  assert.equal(b.transport.asked, a.transport.asked);
  assert.equal(sent(db, 'transport-request').length, 3);
});

test('TRANSPORT_AUTO_DISPATCH=false keeps the directory but sends nothing', () => {
  const { db, mother } = setup();
  const config = require('../src/config');
  config.transport.autoDispatch = false;
  try {
    assert.equal(alerts.createAlert(db, { mother, symptoms: ['sos'], ...AT, channel: 'app' }).transport.asked, 0);
  } finally { config.transport.autoDispatch = true; }
});

test('USSD emergency without GPS asks drivers in her district and still fits the screen limit', () => {
  const { db } = setup();
  mothers.create(db, { phone: PHONE.replace('678', '679'), name: 'Zawadi', lmp: isoAgo(168), facilityId: 1, channel: 'ussd' });
  const out = ussd.handle(db, { phone: PHONE.replace('678', '679'), text: '4*1' });
  assert.match(out, /^END ALERT SENT\./);
  assert.match(out, /Drivers asked to come\./);
  assert.ok(out.length <= 4 + 182, `too long (${out.length}): ${out}`);
  // No GPS: the request says so and gives her district.
  assert.match(sent(db, 'transport-request')[0].body, /Area: Sample Area A \(no GPS\)/);
});

test('USSD result with the longest facility name still fits', () => {
  const { db } = setup();
  db.prepare('UPDATE facilities SET name = ?, phone = NULL, alert_phone = NULL WHERE id IN (3, 4)').run('X'.repeat(80));
  mothers.create(db, { phone: '+256712345600', lmp: isoAgo(168), facilityId: 3, channel: 'ussd' });
  const out = ussd.handle(db, { phone: '+256712345600', text: '4*1' });
  assert.match(out, /Drivers asked to come\./);
  assert.ok(out.length <= 4 + 182, `too long (${out.length}): ${out}`);
});

// ---- web API
async function start() {
  const { db, mother } = setup();
  const server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const code = auth.requestOtp(db, PHONE).code;
  const token = auth.verifyOtp(db, PHONE, code).token;
  const staffToken = staffAuth.issueSession(db, { legacyUser: 'Test Staff' });
  return { db, mother, base, token, staffToken, close: () => new Promise((r) => server.close(r)) };
}
const api = (base, p, { method = 'GET', body, token } = {}) =>
  fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('API: drivers list needs sign-in and hides base locations; SOS returns who was asked', async (t) => {
  const { base, token, staffToken, close } = await start();
  t.after(close);
  assert.equal((await api(base, '/api/transport/nearby?lat=0.348&lng=32.583')).status, 401);
  const near = await api(base, '/api/transport/nearby?lat=0.348&lng=32.583', { token });
  assert.equal(near.status, 200);
  assert.equal(near.body.transport[0].phone, BODA1);
  assert.equal(String(near.body.transport[0].lat).length <= 5, true, 'rounded to 2 decimals');
  assert.equal(near.body.transport[0].notes, undefined);
  assert.equal((await api(base, '/api/transport/nearby?lat=999&lng=0', { token })).status, 400);

  const sos = await api(base, '/api/alerts', { method: 'POST', token, body: { symptoms: ['sos'], lat: 0.348, lng: 32.583 } });
  assert.equal(sos.status, 201);
  assert.equal(sos.body.transport.asked, 3);
  assert.equal(sos.body.transport.nearby[0].phone, BODA1);
  assert.equal(sos.body.transport.nearby[0].notes, undefined);
});

test('API: staff can list, add, validate and deactivate drivers', async (t) => {
  const { base, token, staffToken, close } = await start();
  t.after(close);
  const list = await api(base, '/api/admin/transport', { token: staffToken });
  assert.equal(list.status, 200);
  assert.equal(list.body.transport.length, 5);
  assert.deepEqual(list.body.kinds, transport.KINDS);
  assert.equal(list.body.transport[0].lat !== undefined, true, 'staff do see base locations');

  const bad = (body) => api(base, '/api/admin/transport', { method: 'POST', token: staffToken, body });
  assert.equal((await bad({ name: 'Sam', kind: 'rocket', phone: '0700000199' })).status, 400);
  assert.equal((await bad({ name: '', kind: 'boda', phone: '0700000199' })).status, 400);
  assert.equal((await bad({ name: 'Sam', kind: 'boda', phone: '12' })).status, 400);
  assert.equal((await bad({ name: 'Sam', kind: 'boda', phone: '0700000199', lat: 95, lng: 32 })).status, 400);
  assert.equal((await bad({ name: 'Sam', kind: 'boda', phone: '0700000199', radius_km: -3 })).status, 400);
  assert.equal((await bad({ name: 'Sam', kind: 'boda', phone: '0700000102' })).status, 409, 'number already listed');

  const ok = await bad({ name: 'Sam', kind: 'boda', phone: '0700000199', area: 'Sample Area A', lat: 0.3481, lng: 32.5831, radius_km: 5 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.provider.phone, '+256700000199');
  const id = ok.body.provider.id;
  const near = await api(base, '/api/transport/nearby?lat=0.348&lng=32.583', { token });
  assert.equal(near.body.transport[0].name, 'Sam');

  assert.equal((await api(base, `/api/admin/transport/${id}`, { method: 'PATCH', token: staffToken, body: { active: false } })).body.provider.active, false);
  const after = await api(base, '/api/transport/nearby?lat=0.348&lng=32.583', { token });
  assert.ok(!after.body.transport.some((p) => p.name === 'Sam'));
  assert.equal((await api(base, '/api/admin/transport/9999', { method: 'PATCH', token: staffToken, body: { active: false } })).status, 404);
  assert.equal((await api(base, `/api/admin/transport/${id}`, { method: 'PATCH', token: staffToken, body: { kind: 'rocket' } })).status, 400);
});

test('API: the dashboard shows which drivers were asked and who accepted', async (t) => {
  const { db, base, token, staffToken, close } = await start();
  t.after(close);
  const sos = await api(base, '/api/alerts', { method: 'POST', token, body: { symptoms: ['sos'], lat: 0.348, lng: 32.583 } });
  let a = (await api(base, '/api/admin/alerts', { token: staffToken })).body.alerts[0];
  assert.deepEqual(a.transport.map((x) => x.status), ['sent', 'sent', 'sent']);
  smsCommands.handle(db, { from: '0700000103', text: `GO ${sos.body.alertId}` });
  a = (await api(base, '/api/admin/alerts', { token: staffToken })).body.alerts[0];
  assert.equal(a.transport.find((x) => x.status === 'accepted').phone, TAXI);
  assert.equal(a.transport.filter((x) => x.status === 'taken').length, 2);
});

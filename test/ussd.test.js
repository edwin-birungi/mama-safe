'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ussd = require('../src/ussd');
const mothers = require('../src/mothers');
const { freshDb, ddmmyy, isoAgo, outbox } = require('./helpers');

const PHONE = '+256712345678';
const dial = (db, text, phone = PHONE) => ussd.handle(db, { phone, text });
const registered = (db) => mothers.create(db, { phone: PHONE, name: 'Amina', lmp: isoAgo(168), facilityId: 1, contactPhone: '+256700111222', channel: 'ussd' });

test('unregistered caller sees register / check menu', () => {
  const db = freshDb();
  assert.match(dial(db, ''), /^CON Welcome to MamaSafe\n1\. Register\n2\. Check danger signs/);
});

test('registration flow end to end over USSD', () => {
  const db = freshDb();
  assert.match(dial(db, '1'), /^CON Register/);
  assert.match(dial(db, `1*${ddmmyy(100)}`), /^CON Your clinic: type your district/);
  assert.match(dial(db, `1*${ddmmyy(100)}*sam`), /^CON Which district\?\n1\. Sample Area A\n2\. Sample Area B/);
  assert.match(dial(db, `1*${ddmmyy(100)}*sam*1`), /^CON Sample Area A:\n1\. SAMPLE Referral Hospital/);
  assert.match(dial(db, `1*${ddmmyy(100)}*sam*1*2`), /^CON Phone number of someone/);
  const end = dial(db, `1*${ddmmyy(100)}*sam*1*2*0700111222`);
  assert.match(end, /^END Registered\./);
  assert.match(end, /Week 14/);
  const m = mothers.byPhone(db, PHONE);
  assert.equal(m.channel, 'ussd');
  assert.equal(m.contact_phone, '+256700111222');
  assert.ok(m.facility_id);
  const sent = outbox(db).filter((o) => o.kind === 'welcome');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to_phone, PHONE);
});

test('registration can skip the emergency contact; bad input keeps the screen', () => {
  const db = freshDb();
  const base = `1*${ddmmyy(60)}*sample area a*1`;
  assert.match(dial(db, `1*999999`), /^CON Invalid date/);
  assert.match(dial(db, `${base}*12`), /^CON Invalid number/);
  assert.match(dial(db, `${base}*1`), /^END Registered/);
  assert.equal(mothers.byPhone(db, PHONE).contact_phone, null);
});

test('registered caller gets the full menu and visit info', () => {
  const db = freshDb();
  registered(db);
  assert.match(dial(db, ''), /1\. My next visit\n2\. I feel unwell\n3\. My health facility\n4\. EMERGENCY\n5\. Find a hospital/);
  assert.match(dial(db, '1'), /^CON Visit \d of 8\n/);
  assert.match(dial(db, '3'), /^CON Your facility:\nSAMPLE/);
  assert.match(dial(db, '1*0'), /^CON MamaSafe\n1\. My next visit/);
});

test('danger sign raises one alert and tells the mother, the facility and the contact', () => {
  const db = freshDb();
  registered(db);
  const out = dial(db, '2*1');
  assert.match(out, /^END GO TO A HEALTH FACILITY NOW\./);
  const alerts = db.prepare('SELECT * FROM alerts').all();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].channel, 'ussd');
  assert.deepEqual(JSON.parse(alerts[0].symptoms), ['bleeding']);
  const kinds = outbox(db).map((o) => o.kind).sort();
  assert.deepEqual(kinds, ['alert-contact', 'alert-facility', 'alert-mother']);
  // 24-hour facility chosen even though her own clinic (id 1) is daytime only
  const fac = db.prepare('SELECT * FROM facilities WHERE id = ?').get(alerts[0].facility_id);
  assert.equal(fac.open24, 1);
  assert.equal(fac.area, 'Sample Area A');
});

test('a repeated request does not page the facility twice', () => {
  const db = freshDb();
  registered(db);
  dial(db, '4*1');
  dial(db, '4*1');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 1);
  assert.equal(outbox(db).filter((o) => o.kind === 'alert-facility').length, 1);
});

test('urgent and mild answers do not raise alerts', () => {
  const db = freshDb();
  registered(db);
  assert.match(dial(db, '2*5*5'), /^END See a midwife or doctor TODAY at SAMPLE/);
  assert.match(dial(db, '2*5*7'), /^END Common in pregnancy/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 0);
});

test('unregistered danger sign still gets advice but no alert', () => {
  const db = freshDb();
  const out = dial(db, '2*2');
  assert.match(out, /^END GO TO A HEALTH FACILITY NOW\./);
  assert.match(out, /Register on MamaSafe/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 0);
});

test('invalid choices are rejected politely', () => {
  const db = freshDb();
  registered(db);
  assert.match(dial(db, '9'), /^CON MamaSafe\n1\. My next visit/);
  assert.match(dial(db, '2*8'), /^CON Invalid choice\.\nDo you have:/);
});

test('every screen fits the USSD length limit', () => {
  const db = freshDb();
  const check = (text) => {
    const out = dial(db, text);
    assert.ok(out.length <= 4 + 182, `too long (${out.length}): ${out}`);
  };
  ['', '1', '2', '2*5', '2*8', '1*1', `1*${ddmmyy(30)}`, `1*${ddmmyy(30)}*1`, `1*${ddmmyy(30)}*1*1`].forEach(check);
  registered(db);
  ['', '1', '2', '2*5', '3', '4', '2*8', '1*x'].forEach(check);
});

test('unreadable phone numbers end the session', () => {
  const db = freshDb();
  assert.match(ussd.handle(db, { phone: '', text: '' }), /^END /);
});

test('find a hospital: district search, paged list, and every number we hold', () => {
  const db = freshDb();
  db.prepare("UPDATE facilities SET emergency_phone='+256414675065', toll_free='+256800100036' WHERE code='SHOSP'").run();
  assert.match(dial(db, '3'), /^CON Find a hospital: type your district/);
  assert.match(dial(db, '3*s'), /^CON Type at least 2 letters/);
  assert.match(dial(db, '3*zzz'), /^CON No district found/);
  const list = dial(db, '3*sample area a');
  assert.match(list, /^CON Sample Area A:\n1\. SAMPLE Referral Hospital/);
  const detail = dial(db, '3*sample area a*1');
  assert.match(detail, /Tel 0700000004\nEmergency 0414675065\nToll-free 0800100036/);
  assert.match(dial(db, '3*sample area a*1*0'), /^CON Sample Area A:/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mothers').get().n, 0); // browsing never registers anyone
});

test('facility lists page four at a time', () => {
  const db = freshDb();
  for (let i = 0; i < 6; i++) db.prepare("INSERT INTO facilities (code,name,kind,area) VALUES (?,?,?,?)").run('P' + i, 'Pager Clinic ' + i, 'clinic', 'Pagerland');
  const p1 = dial(db, '3*pager');
  assert.match(p1, /9\. More/);
  const p2 = dial(db, '3*pager*9');
  assert.match(p2, /1\. Pager Clinic \d\n2\. Pager Clinic \d\n0\. Back/);
  assert.ok(!/9\. More/.test(p2));
});

test('SOS says the facility is told only when an SMS really went to it', () => {
  const db = freshDb();
  registered(db);
  db.prepare("UPDATE facilities SET alert_phone = NULL").run(); // none can receive SMS
  const out = dial(db, '4*1');
  assert.match(out, /We could not message them/);
  assert.ok(!/has been told/.test(out));
  const a = db.prepare('SELECT * FROM alerts').get();
  assert.equal(a.notified, 0);
  assert.equal(outbox(db).filter((o) => o.kind === 'alert-facility').length, 0);
  assert.match(outbox(db).find((o) => o.kind === 'alert-mother').body, /We could not message them, so please call/);
});

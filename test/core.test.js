'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const triage = require('../src/triage');
const schedule = require('../src/schedule');
const { normalizePhone } = require('../src/phone');
const { parseCsv } = require('../src/importFacilities');
const facilities = require('../src/facilities');
const { freshDb } = require('./helpers');

test('triage: highest level wins and unknown ids are ignored', () => {
  assert.equal(triage.classify([]).level, 'none');
  assert.equal(triage.classify(['mild']).level, 'mild');
  assert.equal(triage.classify(['mild', 'swelling']).level, 'urgent');
  assert.equal(triage.classify(['mild', 'swelling', 'bleeding']).level, 'emergency');
  assert.equal(triage.classify(['nonsense']).level, 'none');
  assert.equal(triage.classify(['sos']).level, 'emergency');
});

test('triage: hidden sos is not offered as a symptom', () => {
  assert.ok(!triage.visibleSymptoms().some((s) => s.id === 'sos'));
});

test('phone numbers normalise to E.164', () => {
  assert.equal(normalizePhone('0712 345 678'), '+256712345678');
  assert.equal(normalizePhone('712345678'), '+256712345678');
  assert.equal(normalizePhone('+256712345678'), '+256712345678');
  assert.equal(normalizePhone('256712345678'), '+256712345678');
  assert.equal(normalizePhone('0712'), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone(''), null);
});

test('schedule: eight contacts, due date, gestation', () => {
  const today = schedule.parseDate('2026-10-18');
  const lmp = '2026-05-10'; // 161 days ago = 23 weeks
  assert.equal(schedule.gestation(lmp, today).weeks, 23);
  assert.equal(schedule.edd(lmp), '2027-02-14');
  const v = schedule.visits(lmp, today);
  assert.equal(v.length, 8);
  assert.deepEqual(v.map((x) => x.week), [12, 20, 26, 30, 34, 36, 38, 40]);
  assert.equal(v[0].status, 'past');
  assert.equal(v[1].status, 'past');
  assert.equal(v[2].status, 'next');
  assert.equal(v[2].date, '2026-11-08');
  assert.equal(v[3].status, 'upcoming');
});

test('schedule: a visit today counts as next', () => {
  const lmp = '2026-01-01';
  const day = schedule.fmt(schedule.addDays(schedule.parseDate(lmp), 12 * 7));
  assert.equal(schedule.nextVisit(lmp, schedule.parseDate(day)).no, 1);
});

test('schedule: DDMMYY validation', () => {
  const today = schedule.parseDate('2026-10-18');
  assert.equal(schedule.parseDdmmyy('120426', today), '2026-04-12');
  assert.equal(schedule.parseDdmmyy('311326', today), null); // month 13
  assert.equal(schedule.parseDdmmyy('300226', today), null); // 30 Feb
  assert.equal(schedule.parseDdmmyy('191026', today), null); // tomorrow
  assert.equal(schedule.parseDdmmyy('010125', today), null); // over 40 weeks ago
  assert.equal(schedule.parseDdmmyy('12042', today), null);
});

test('csv parser handles quotes and commas', () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('facilities: sample data loads, sorted by distance, 24h filter', () => {
  const db = freshDb();
  assert.equal(facilities.list(db).length, 6);
  const near = facilities.list(db, { lat: 0.3476, lng: 32.5825 });
  assert.equal(near[0].code, 'SHC3A');
  assert.ok(near[0].distanceKm < 0.1);
  assert.ok(facilities.list(db, { open24: true }).every((f) => f.open24));
  assert.deepEqual(facilities.areas(db), ['Sample Area A', 'Sample Area B']);
  assert.equal(facilities.byCode(db, 'shc4a').name, 'SAMPLE Health Centre IV (Area A)');
});

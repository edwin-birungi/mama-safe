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
  assert.deepEqual(facilities.searchAreas(db, 'sample area b'), ['Sample Area B']);
  assert.equal(facilities.byCode(db, 'shc4a').name, 'SAMPLE Health Centre IV (Area A)');
});

test('OSM import: adds clinics and health centres, skips duplicates and unnamed, keeps curated rows', () => {
  const { importOsm } = require('../src/importFacilities');
  const db = freshDb();
  const before = facilities.count(db);
  const osm = { elements: [
    { type: 'node', id: 1, lat: 0.3477, lon: 32.5826, tags: { name: 'SAMPLE Health Centre III (Area A)', amenity: 'clinic' } }, // duplicate of a curated row
    { type: 'node', id: 2, lat: 2.77, lon: 32.30, tags: { name: 'Pece HC III', amenity: 'clinic', phone: '+256 800 100 111; 0771 234 567', 'addr:district': 'Gulu', opening_hours: '24/7' } },
    { type: 'way', id: 3, center: { lat: 0.5, lon: 32.9 }, tags: { name: 'Kampala Care Hospital', amenity: 'hospital', 'addr:city': 'Kampala' } },
    { type: 'node', id: 4, lat: 1, lon: 32, tags: { amenity: 'clinic' } },
    { type: 'node', id: 5, tags: { name: 'No Coordinates Clinic' } }
  ] };
  const r = importOsm(db, osm);
  assert.equal(r.imported, 2);
  assert.deepEqual(r.skipped, { unnamed: 1, noCoordinates: 1, duplicate: 1 });
  assert.equal(facilities.count(db), before + 2);
  const pece = facilities.byCode(db, 'OSM-n2');
  assert.equal(pece.kind, 'health_centre');
  assert.equal(pece.level, 'HC III');
  assert.equal(pece.toll_free, '+256800100111');
  assert.equal(pece.phone, '+256771234567');
  assert.equal(pece.open24, true);
  assert.equal(pece.area, 'Gulu');
  assert.equal(facilities.byCode(db, 'OSM-w3').kind, 'hospital');
  assert.equal(importOsm(db, osm).imported, 0); // re-running adds nothing
});

test('CSV import splits a toll-free number out of a combined phone cell', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { importCsv } = require('../src/importFacilities');
  const { open } = require('../src/db');
  const db = open(':memory:');
  const f = path.join(os.tmpdir(), 'ms-test-' + process.pid + '.csv');
  fs.writeFileSync(f, 'Facility Name,District,Telephone,Latitude,Longitude\nBetty HC IV,Gulu,"0414 111 222; 0800 100 200",2.78,32.3\n');
  importCsv(db, f); fs.unlinkSync(f);
  const r = facilities.byCode(db, 'betty-hc-iv-gulu');
  assert.equal(r.phone, '+256414111222');
  assert.equal(r.toll_free, '+256800100200');
  assert.equal(r.kind, 'health_centre');
  assert.equal(r.level, 'HC IV');
});

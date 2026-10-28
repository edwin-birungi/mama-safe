'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const reminders = require('../src/reminders');
const mothers = require('../src/mothers');
const schedule = require('../src/schedule');
const { freshDb, outbox } = require('./helpers');

// Visit 3 (week 26) falls on 2026-11-04 for this LMP.
const LMP = schedule.fmt(schedule.addDays(schedule.parseDate('2026-11-04'), -26 * 7));
const at = (iso) => new Date(iso); // times are UTC; the service runs on UTC+3

function setup(opts = {}) {
  const db = freshDb();
  mothers.create(db, { phone: '+256712345678', name: 'Amina', lmp: LMP, facilityId: 1, smsOptin: opts.optin !== false, channel: 'ussd' });
  return db;
}

test('sends reminders 3 days before, 1 day before and on the day', () => {
  const db = setup();
  assert.equal(reminders.run(db, at('2026-11-01T07:00:00Z')), 1);
  assert.equal(reminders.run(db, at('2026-11-03T07:00:00Z')), 1);
  assert.equal(reminders.run(db, at('2026-11-04T07:00:00Z')), 1);
  const msgs = outbox(db).filter((o) => o.kind === 'reminder').map((o) => o.body);
  assert.equal(msgs.length, 3);
  assert.match(msgs[0], /visit 3 of 8 is in 3 days \(Wed 4 Nov\) at SAMPLE/);
  assert.match(msgs[1], /is TOMORROW/);
  assert.match(msgs[2], /is TODAY/);
});

test('never sends the same reminder twice', () => {
  const db = setup();
  assert.equal(reminders.run(db, at('2026-11-01T07:00:00Z')), 1);
  assert.equal(reminders.run(db, at('2026-11-01T08:00:00Z')), 0);
  assert.equal(outbox(db).length, 1);
});

test('quiet outside daytime hours (East Africa time)', () => {
  const db = setup();
  assert.equal(reminders.run(db, at('2026-11-01T02:00:00Z')), 0); // 05:00 local
  assert.equal(reminders.run(db, at('2026-11-01T18:00:00Z')), 0); // 21:00 local
  assert.equal(reminders.run(db, at('2026-11-01T06:00:00Z')), 1); // 09:00 local
});

test('respects SMS opt-out and ignores days with no reminder', () => {
  const db = setup({ optin: false });
  assert.equal(reminders.run(db, at('2026-11-01T07:00:00Z')), 0);
  const db2 = setup();
  assert.equal(reminders.run(db2, at('2026-11-02T07:00:00Z')), 0); // 2 days before: none
});

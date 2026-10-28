'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sms = require('../src/smsCommands');
const mothers = require('../src/mothers');
const { freshDb, ddmmyy, isoAgo, outbox } = require('./helpers');

const FROM = '0712345678';
const PHONE = '+256712345678';
const text = (db, t, from = FROM) => sms.handle(db, { from, text: t });
const reg = (db) => mothers.create(db, { phone: PHONE, name: 'Amina', lmp: isoAgo(168), facilityId: 1, contactPhone: '+256700111222', channel: 'sms' });

test('unregistered people get registration help', () => {
  const db = freshDb();
  assert.match(text(db, 'hello'), /To register text REG DDMMYY CODE/);
  assert.match(text(db, 'HELP'), /To register text REG/);
});

test('REG registers with date, clinic code and optional name', () => {
  const db = freshDb();
  const reply = text(db, `reg ${ddmmyy(100)} shc4a Grace`);
  assert.match(reply, /^MamaSafe: Welcome Grace\. You are in week 14/);
  const m = mothers.byPhone(db, PHONE);
  assert.equal(m.name, 'Grace');
  assert.equal(m.channel, 'sms');
  assert.match(text(db, `REG ${ddmmyy(100)} SHC4A`), /already registered/);
});

test('REG explains bad dates and unknown clinic codes', () => {
  const db = freshDb();
  assert.match(text(db, 'REG 999999 SHC4A'), /date not understood/);
  const r = text(db, `REG ${ddmmyy(50)} NOPE`);
  assert.match(r, /clinic code not found/);
  assert.match(r, /SHC3A=SAMPLE Health Centre III/);
  assert.equal(mothers.byPhone(db, PHONE), null);
});

test('SYMPTOM menu, urgent advice and emergency alert', () => {
  const db = freshDb();
  reg(db);
  assert.match(text(db, 'SYMPTOM'), /reply SYMPTOM and the numbers/);
  assert.match(text(db, 'SYMPTOM 9'), /Get checked by a midwife or doctor today/);
  assert.equal(text(db, 'SYMPTOM 1 9'), null); // alert sends its own messages
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 1);
  assert.equal(outbox(db).filter((o) => o.kind === 'alert-facility').length, 1);
});

test('SYMPTOM works before registering, without raising an alert', () => {
  const db = freshDb();
  assert.match(text(db, 'SYMPTOM 2'), /GO TO A HEALTH FACILITY NOW/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 0);
});

test('SOS raises an alert; unregistered SOS gives advice', () => {
  const db = freshDb();
  assert.match(text(db, 'SOS'), /GO TO A HEALTH FACILITY NOW/);
  reg(db);
  assert.equal(text(db, 'sos'), null);
  const a = db.prepare('SELECT * FROM alerts').get();
  assert.equal(a.channel, 'sms');
  assert.deepEqual(JSON.parse(a.symptoms), ['sos']);
});

test('VISIT, CLINIC, STOP and START', () => {
  const db = freshDb();
  reg(db);
  assert.match(text(db, 'VISIT'), /visit \d of 8 is \w{3} \d+ \w{3} at SAMPLE/);
  assert.match(text(db, 'CLINIC'), /your clinic is SAMPLE Health Centre III/);
  assert.match(text(db, 'STOP'), /no longer get visit reminders/);
  assert.equal(mothers.byPhone(db, PHONE).sms_optin, false);
  assert.match(text(db, 'START'), /reminders are on again/);
  assert.equal(mothers.byPhone(db, PHONE).sms_optin, true);
});

test('facility can acknowledge an alert by SMS, only from its own number', () => {
  const db = freshDb();
  reg(db);
  text(db, 'SOS');
  const a = db.prepare('SELECT * FROM alerts').get();
  const fac = db.prepare('SELECT phone FROM facilities WHERE id = ?').get(a.facility_id);
  assert.equal(text(db, `ACK ${a.id}`, '0799999999'), null); // stranger: ignored
  assert.equal(db.prepare('SELECT status FROM alerts').get().status, 'new');
  assert.match(text(db, `ACK ${a.id}`, fac.phone), /acknowledged/);
  assert.equal(db.prepare('SELECT status FROM alerts').get().status, 'acknowledged');
  assert.match(text(db, `ACK ${a.id}`, fac.phone), /no open alert/);
});

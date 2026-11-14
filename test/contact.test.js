'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const contact = require('../src/contact');
const mothers = require('../src/mothers');
const alerts = require('../src/alerts');
const auth = require('../src/auth');
const ussd = require('../src/ussd');
const smsCommands = require('../src/smsCommands');
const { freshDb, isoAgo, outbox } = require('./helpers');

const PHONE = '+256712345678', CONTACT = '+256700111222';
const codeSms = (db, to) => outbox(db).filter((o) => o.kind === 'otp' && o.to_phone === to).pop();
const codeOf = (db, to) => codeSms(db, to).body.match(/\b(\d{6})\b/)[1];
const wrongCode = (c) => (c === '000000' ? '111111' : '000000');
function setup(extra = {}) {
  const db = freshDb();
  const mother = mothers.create(db, { phone: PHONE, name: 'Amina', lmp: isoAgo(168), facilityId: 1, contactPhone: CONTACT, channel: 'app', ...extra });
  return { db, mother };
}
const fresh = (db) => mothers.byId(db, 1);

test('the code goes to the emergency contact, never to the mother, and names who is asking', () => {
  const { db, mother } = setup();
  const r = contact.requestCode(db, mother);
  assert.equal(r.ok, true);
  const msgs = outbox(db).filter((o) => o.kind === 'otp');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].to_phone, CONTACT);
  assert.match(msgs[0].body, /Amina \(0712345678\) wants to list you as her emergency contact/);
  assert.match(msgs[0].body, new RegExp(r.code));
  assert.equal(msgs.filter((o) => o.to_phone === PHONE).length, 0);
  // Only a hash is stored.
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM contact_codes').all()), new RegExp(r.code));
});

test('the right code confirms the contact; a second confirm is harmless', () => {
  const { db, mother } = setup();
  const { code } = contact.requestCode(db, mother);
  assert.equal(fresh(db).contact_verified_at, null);
  assert.equal(contact.verifyCode(db, fresh(db), code).ok, true);
  assert.ok(fresh(db).contact_verified_at);
  assert.equal(contact.verifyCode(db, fresh(db), code).already, true);
  assert.match(contact.requestCode(db, fresh(db)).error, /already confirmed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_codes').get().n, 0, 'code is single use');
});

test('wrong codes are counted and lock after five tries, even for the right code', () => {
  const { db, mother } = setup();
  const { code } = contact.requestCode(db, mother);
  for (let i = 0; i < 5; i++) assert.equal(contact.verifyCode(db, fresh(db), wrongCode(code)).error, 'Wrong code.');
  assert.match(contact.verifyCode(db, fresh(db), code).error, /Too many wrong tries/);
  assert.equal(fresh(db).contact_verified_at, null);
  // A new code resets the counter.
  const again = contact.requestCode(db, fresh(db));
  assert.equal(contact.verifyCode(db, fresh(db), again.code).ok, true);
});

test('codes expire after 10 minutes', () => {
  const { db, mother } = setup();
  const t0 = Date.now();
  const { code } = contact.requestCode(db, mother, t0);
  assert.match(contact.verifyCode(db, fresh(db), code, t0 + 10 * 60000 + 1).error, /expired/);
  assert.equal(contact.verifyCode(db, fresh(db), code, t0 + 9 * 60000).ok, true);
});

test('no more than 3 codes an hour', () => {
  const { db, mother } = setup();
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) assert.equal(contact.requestCode(db, fresh(db), t0 + i * 1000).ok, true);
  const r = contact.requestCode(db, fresh(db), t0 + 5000);
  assert.match(r.error, /Too many codes/);
  assert.equal(outbox(db).filter((o) => o.kind === 'otp').length, 3);
  assert.equal(contact.requestCode(db, fresh(db), t0 + 61 * 60000).ok, true);
});

test('changing the contact removes the confirmation and kills the old code', () => {
  const { db, mother } = setup();
  const old = contact.requestCode(db, mother).code;
  mothers.update(db, 1, { contactPhone: '+256700333444' });
  assert.match(contact.verifyCode(db, fresh(db), old).error, /expired/, 'a code sent to the old number is useless');
  const fix = contact.requestCode(db, fresh(db));
  assert.equal(codeSms(db, '+256700333444').body.includes(fix.code), true);
  contact.verifyCode(db, fresh(db), fix.code);
  assert.ok(fresh(db).contact_verified_at);
  mothers.update(db, 1, { contactPhone: '+256700555666' });
  assert.equal(fresh(db).contact_verified_at, null);
  // Saving the same number again does not undo a confirmation.
  const c2 = contact.requestCode(db, fresh(db));
  contact.verifyCode(db, fresh(db), c2.code);
  mothers.update(db, 1, { contactPhone: '+256700555666' });
  assert.ok(fresh(db).contact_verified_at);
});

test('no contact saved: nothing is sent', () => {
  const { db, mother } = setup({ contactPhone: null });
  assert.match(contact.requestCode(db, mother).error, /Add an emergency contact/);
  assert.equal(outbox(db).length, 0);
});

test('emergency alerts still reach an unconfirmed contact (safety first), and the dashboard says so', () => {
  const { db, mother } = setup();
  alerts.createAlert(db, { mother, symptoms: ['sos'], channel: 'app' });
  assert.ok(outbox(db).some((o) => o.kind === 'alert-contact' && o.to_phone === CONTACT));
  assert.equal(alerts.listForDashboard(db)[0].contact_verified, false);
  const { code } = contact.requestCode(db, fresh(db));
  contact.verifyCode(db, fresh(db), code);
  assert.equal(alerts.listForDashboard(db)[0].contact_verified, true);
});

test('SMS: CONTACT <number> saves and texts the contact; CONFIRM <code> confirms', () => {
  const { db } = setup({ contactPhone: null });
  assert.match(smsCommands.handle(db, { from: PHONE, text: 'CONTACT' }), /no emergency contact saved/);
  assert.match(smsCommands.handle(db, { from: PHONE, text: 'CONTACT 12' }), /not valid/);
  assert.match(smsCommands.handle(db, { from: PHONE, text: 'CONTACT 0712345678' }), /must be someone else/);
  const reply = smsCommands.handle(db, { from: PHONE, text: 'CONTACT 0700111222' });
  assert.match(reply, /texted a code to 0700111222/);
  assert.equal(fresh(db).contact_phone, CONTACT);
  assert.match(smsCommands.handle(db, { from: PHONE, text: `CONFIRM ${wrongCode(codeOf(db, CONTACT))}` }), /Wrong code/);
  assert.match(smsCommands.handle(db, { from: PHONE, text: `CONFIRM ${codeOf(db, CONTACT)}` }), /confirmed/);
  assert.ok(fresh(db).contact_verified_at);
});

test('SMS: unregistered numbers cannot use CONTACT or CONFIRM', () => {
  const db = freshDb();
  assert.match(smsCommands.handle(db, { from: '0755555555', text: 'CONTACT 0700111222' }), /To register text REG/);
  assert.equal(outbox(db).length, 0);
});

test('USSD: option 7 appears only while the contact is unconfirmed, and walks through send then confirm', () => {
  const { db } = setup();
  const menu = ussd.handle(db, { phone: PHONE, text: '' });
  assert.match(menu, /5\. Find a hospital\n7\. Confirm contact$/m);
  assert.match(ussd.handle(db, { phone: PHONE, text: '7' }), /^CON Emergency contact 0700111222\n1\. Send them a code\n2\. I have the code/);

  const sent = ussd.handle(db, { phone: PHONE, text: '7*1' });
  assert.match(sent, /^END Code sent to 0700111222\./);
  const code = codeOf(db, CONTACT);

  assert.match(ussd.handle(db, { phone: PHONE, text: '7*2' }), /^CON Type the 6-digit code/);
  assert.match(ussd.handle(db, { phone: PHONE, text: '7*2*12' }), /^CON Type the 6-digit code/);
  assert.match(ussd.handle(db, { phone: PHONE, text: `7*2*${wrongCode(code)}` }), /^END Wrong code\./);
  const done = ussd.handle(db, { phone: PHONE, text: `7*2*${code}` });
  assert.match(done, /^END Contact confirmed\./);
  assert.ok(fresh(db).contact_verified_at);
  assert.doesNotMatch(ussd.handle(db, { phone: PHONE, text: '' }), /Confirm contact/);
  assert.match(ussd.handle(db, { phone: PHONE, text: '7' }), /^CON MamaSafe\n1\. My next visit/); // option 7 is gone
  for (const t of ['7', '7*1', '7*2', `7*2*${code}`]) assert.ok(ussd.handle(db, { phone: PHONE, text: t }).length <= 4 + 182);
});

test('USSD: a mother with no contact never sees option 7', () => {
  const { db } = setup({ contactPhone: null });
  assert.doesNotMatch(ussd.handle(db, { phone: PHONE, text: '' }), /Confirm contact/);
});

// ---- web API
async function start() {
  const { db, mother } = setup();
  const server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = auth.verifyOtp(db, PHONE, auth.requestOtp(db, PHONE).code).token;
  return { db, mother, base, token, close: () => new Promise((r) => server.close(r)) };
}
const api = (base, p, { method = 'GET', body, token } = {}) =>
  fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('API: request a code for the contact, confirm it, and the profile shows it', async (t) => {
  const { db, base, token, close } = await start();
  t.after(close);
  assert.equal((await api(base, '/api/contact/request', { method: 'POST' })).status, 401);
  assert.equal((await api(base, '/api/me', { token })).body.mother.contactVerified, false);

  const req = await api(base, '/api/contact/request', { method: 'POST', token });
  assert.equal(req.status, 200);
  assert.equal(req.body.sentTo, CONTACT);
  assert.match(req.body.devCode, /^\d{6}$/);
  assert.equal(codeSms(db, CONTACT).to_phone, CONTACT);

  assert.equal((await api(base, '/api/contact/verify', { method: 'POST', token, body: { code: wrongCode(req.body.devCode) } })).status, 400);
  const ok = await api(base, '/api/contact/verify', { method: 'POST', token, body: { code: req.body.devCode } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mother.contactVerified, true);
  assert.equal((await api(base, '/api/contact/request', { method: 'POST', token })).status, 400, 'already confirmed');

  // Changing the number via the profile undoes the confirmation.
  const patched = await api(base, '/api/me', { method: 'PATCH', token, body: { contactPhone: '0700999888' } });
  assert.equal(patched.body.mother.contactVerified, false);
});

test('API: the code is never returned in production', async (t) => {
  const config = require('../src/config');
  const { base, token, close } = await start();
  t.after(close);
  config.env = 'production';
  try {
    const req = await api(base, '/api/contact/request', { method: 'POST', token });
    assert.equal(req.status, 200);
    assert.equal(req.body.devCode, undefined);
  } finally { config.env = 'development'; }
});

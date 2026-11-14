'use strict';
// Africa's Talking delivery, tested against a stand-in for its API (no real SMS is sent).
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const sms = require('../src/sms');
const auth = require('../src/auth');
const mothers = require('../src/mothers');
const { createServer } = require('../src/server');
const { freshDb, isoAgo } = require('./helpers');

const realFetch = globalThis.fetch;
const AT_OK = (to) => JSON.stringify({ SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ number: to, status: 'Success', statusCode: 101 }] } });
let calls;
function stub(handler) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('africastalking.com')) return realFetch(url, opts);
    calls.push({ url: String(url), headers: opts.headers, form: new URLSearchParams(String(opts.body)) });
    return handler(calls[calls.length - 1]);
  };
}
async function withAt(settings, fn) {
  const saved = { ...config.at };
  Object.assign(config.at, { username: 'mamasafe', apiKey: 'test-key', senderId: '', sandbox: false }, settings);
  try { await fn(); } finally { Object.assign(config.at, saved); globalThis.fetch = realFetch; }
}
const row = (db, id) => db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);

test('a code is sent with the right host, key, username, number and text, then wiped from the log', async () => {
  const db = freshDb();
  await withAt({}, async () => {
    stub((c) => new Response(AT_OK(c.form.get('to')), { status: 201 }));
    const r = auth.requestOtp(db, '+256783404315');
    await sms.settled(r.smsId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.africastalking.com/version1/messaging');
    assert.equal(calls[0].headers.apiKey, 'test-key');
    assert.equal(calls[0].form.get('username'), 'mamasafe');
    assert.equal(calls[0].form.get('to'), '+256783404315');
    assert.match(calls[0].form.get('message'), new RegExp(`MamaSafe code: ${r.code}\\b`));
    assert.equal(calls[0].form.has('from'), false, 'no sender id unless one is configured');
    assert.equal(row(db, r.smsId).status, 'sent');
    assert.equal(row(db, r.smsId).body, '[one-time code removed]');
  });
});

test('sandbox mode uses the sandbox host, and a sender id is sent only when set', async () => {
  const db = freshDb();
  await withAt({ sandbox: true, username: 'sandbox', senderId: 'MamaSafe' }, async () => {
    stub((c) => new Response(AT_OK(c.form.get('to')), { status: 201 }));
    await sms.settled(sms.send(db, '+256783404315', 'hello'));
    assert.match(calls[0].url, /^https:\/\/api\.sandbox\.africastalking\.com\//);
    assert.equal(calls[0].form.get('from'), 'MamaSafe');
  });
});

test('a wrong username or key is recorded as failed WITH the reason (plain-text 401)', async () => {
  const db = freshDb();
  await withAt({}, async () => {
    stub(() => new Response('The supplied authentication is invalid', { status: 401 }));
    const id = sms.send(db, '+256783404315', 'hello');
    await sms.settled(id);
    assert.equal(row(db, id).status, 'failed');
    assert.match(row(db, id).error, /HTTP 401: The supplied authentication is invalid/);
  });
});

test('a number rejected by the provider, or a network failure, is recorded as failed', async () => {
  const db = freshDb();
  await withAt({}, async () => {
    stub(() => new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ number: '+256', status: 'InvalidPhoneNumber', statusCode: 403 }] } }), { status: 201 }));
    const a = sms.send(db, '+256783404315', 'x'); await sms.settled(a);
    assert.match(row(db, a).error, /InvalidPhoneNumber/);
    stub(() => { throw new Error('getaddrinfo ENOTFOUND'); });
    const b = sms.send(db, '+256783404315', 'x'); await sms.settled(b);
    assert.equal(row(db, b).status, 'failed');
    assert.match(row(db, b).error, /ENOTFOUND/);
  });
});

test('without credentials nothing is sent and messages stay in dry-run', async () => {
  const db = freshDb();
  stub(() => { throw new Error('should not be called'); });
  try {
    const id = sms.send(db, '+256783404315', 'hello');
    assert.equal(row(db, id).status, 'dry-run');
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = realFetch; }
});

test('retry resends failed messages but never an old sign-in code', async () => {
  const db = freshDb();
  await withAt({}, async () => {
    stub(() => new Response('The supplied authentication is invalid', { status: 401 }));
    const otp = auth.requestOtp(db, '+256783404315').smsId;
    const alert = sms.send(db, '+256783404315', 'visit reminder', 'reminder');
    await Promise.all([sms.settled(otp), sms.settled(alert)]);
    stub((c) => new Response(AT_OK(c.form.get('to')), { status: 201 }));
    await sms.retryPending(db);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].form.get('message'), 'visit reminder');
    assert.equal(row(db, otp).status, 'failed');
    assert.equal(row(db, alert).status, 'sent');
  });
});

async function start(db) {
  const server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const post = (base, p, body, token) => realFetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('web sign-in: a failed SMS is reported straight away, a delivered one is not', async (t) => {
  const db = freshDb();
  const { base, close } = await start(db);
  t.after(close);
  await withAt({}, async () => {
    stub(() => new Response('The supplied authentication is invalid', { status: 401 }));
    const bad = await post(base, '/api/otp/request', { phone: '0783404315' });
    assert.equal(bad.status, 502);
    assert.match(bad.body.error, /could not send the SMS/);

    stub((c) => new Response(AT_OK(c.form.get('to')), { status: 201 }));
    const good = await post(base, '/api/otp/request', { phone: '0783404316' });
    assert.equal(good.status, 200);
    assert.equal(good.body.ok, true);
    assert.equal(good.body.phone, '+256783404316');
  });
});

test('emergency-contact code: a failed SMS to the contact is reported', async (t) => {
  const db = freshDb();
  const mother = mothers.create(db, { phone: '+256712345678', lmp: isoAgo(168), facilityId: 1, contactPhone: '+256700111222', channel: 'app' });
  const token = auth.verifyOtp(db, mother.phone, auth.requestOtp(db, mother.phone).code).token;
  const { base, close } = await start(db);
  t.after(close);
  await withAt({}, async () => {
    stub(() => new Response('The supplied authentication is invalid', { status: 401 }));
    const bad = await post(base, '/api/contact/request', {}, token);
    assert.equal(bad.status, 502);
    assert.match(bad.body.error, /could not text that number/);
  });
});

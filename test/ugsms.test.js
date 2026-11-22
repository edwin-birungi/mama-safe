'use strict';
// UGSMS delivery, tested against a stand-in for its API (no real SMS is sent).
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const sms = require('../src/sms');
const { freshDb } = require('./helpers');

const realFetch = globalThis.fetch;
const OK = (phone) => JSON.stringify({ status: 'success', message_id: 'msg_1', recipients: 1, results: [{ phone, status: 'sent', transaction_id: 'tx_1' }] });
let calls;
function stub(handler) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('ugmail.co')) return realFetch(url, opts);
    calls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    return handler(calls[calls.length - 1]);
  };
}
async function withUgsms(fn, settings = {}) {
  const saved = { ...config.ugsms };
  Object.assign(config.ugsms, { apiKey: 'ugs_test', senderId: 'MamaSafe' }, settings);
  try { await fn(); } finally { Object.assign(config.ugsms, saved); globalThis.fetch = realFetch; }
}
const row = (db, id) => db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);

test('the sender name defaults to MamaSafe', () => {
  assert.equal(config.ugsms.senderId, 'MamaSafe');
});

test('a message goes to UGSMS with the key, the number, the text and the MamaSafe sender name', async () => {
  const db = freshDb();
  await withUgsms(async () => {
    stub(() => new Response(OK('256783404315'), { status: 200 }));
    const id = sms.send(db, '+256783404315', 'MamaSafe: hello');
    await sms.settled(id);
    assert.equal(sms.provider(), 'ugsms');
    assert.equal(calls[0].url, 'https://sms.ugmail.co/api/v1/sms/send');
    assert.equal(calls[0].headers['X-API-Key'], 'ugs_test');
    assert.deepEqual(calls[0].body, { to: ['+256783404315'], message: 'MamaSafe: hello', sender_id: 'MamaSafe' });
    assert.equal(row(db, id).status, 'sent');
  });
});

test('a sign-in code is wiped from the log once it is delivered', async () => {
  const db = freshDb();
  await withUgsms(async () => {
    stub(() => new Response(OK('256783404315'), { status: 200 }));
    const id = sms.send(db, '+256783404315', 'MamaSafe code: 123456', 'otp');
    await sms.settled(id);
    assert.equal(row(db, id).status, 'sent');
    assert.doesNotMatch(row(db, id).body, /123456/);
  });
});

test('an empty wallet (402) is recorded as failed with the reason, and retried later', async () => {
  const db = freshDb();
  await withUgsms(async () => {
    stub(() => new Response(JSON.stringify({ status: 'error', error: 'insufficient_balance' }), { status: 402 }));
    const id = sms.send(db, '+256783404315', 'visit reminder', 'reminder');
    await sms.settled(id);
    assert.equal(row(db, id).status, 'failed');
    assert.match(row(db, id).error, /402.*insufficient_balance/);
    stub(() => new Response(OK('256783404315'), { status: 200 }));
    await sms.retryPending(db);
    assert.equal(row(db, id).status, 'sent');
  });
});

test('a wrong key (401) and a network failure are both recorded as failed', async () => {
  const db = freshDb();
  await withUgsms(async () => {
    stub(() => new Response(JSON.stringify({ status: 'error', error: 'unauthorized' }), { status: 401 }));
    const a = sms.send(db, '+256783404315', 'x'); await sms.settled(a);
    assert.equal(row(db, a).status, 'failed');
    globalThis.fetch = async () => { throw new Error('network down'); };
    const b = sms.send(db, '+256783404315', 'y'); await sms.settled(b);
    assert.match(row(db, b).error, /UGSMS: network down/);
  });
});

test('demo phones never reach UGSMS', async () => {
  const db = freshDb();
  const demo = require('../src/demo');
  await withUgsms(async () => {
    stub(() => new Response(OK('x'), { status: 200 }));
    const phone = (demo.DEMO_PHONES && demo.DEMO_PHONES[0]) || '+256700000001';
    if (!demo.isDemoPhone(phone)) return; // demo access is switched off in this setup
    sms.send(db, phone, 'hi');
    assert.equal(calls.length, 0);
  });
});

test('without a UGSMS key the app falls back to Africa\'s Talking, and with neither it stays in dry-run', () => {
  const savedAt = { ...config.at };
  const savedUg = { ...config.ugsms };
  try {
    config.ugsms.apiKey = '';
    Object.assign(config.at, { username: '', apiKey: '' });
    assert.equal(sms.provider(), 'none');
    Object.assign(config.at, { username: 'mamasafe', apiKey: 'k' });
    assert.equal(sms.provider(), 'africastalking');
  } finally { Object.assign(config.at, savedAt); Object.assign(config.ugsms, savedUg); }
});

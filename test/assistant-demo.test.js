'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const config = require('../src/config');
const assistant = require('../src/assistant');
const questions = require('../src/questions');
const mothers = require('../src/mothers');
const alerts = require('../src/alerts');
const auth = require('../src/auth');
const demo = require('../src/demo');
const { freshDb, isoAgo, outbox } = require('./helpers');

const mk = (db, over = {}) => mothers.create(db, { phone: '+256712345678', name: 'Amina', lmp: isoAgo(168), facilityId: 1, channel: 'app', ...over });
let M; const kind = (db, t) => assistant.answer(t, M || (M = mk(db))).kind;

test('assistant: danger signs are always escalated, never answered as small talk', () => {
  const db = freshDb(); M = null;
  for (const t of ['I am bleeding', 'heavy blood coming out', 'she had a fit', 'severe headache and blurred vision', 'my baby stopped moving', 'my waters broke', 'I cannot breathe well', 'severe belly pain'])
    assert.equal(kind(db, t), 'emergency', t);
  assert.notEqual(kind(db, 'what is a normal blood pressure'), 'emergency');
  assert.notEqual(kind(db, 'do I need a blood test'), 'emergency');
  assert.equal(kind(db, 'I want to kill myself'), 'crisis');
  assert.equal(kind(db, 'I have a fever'), 'urgent');
  assert.equal(kind(db, 'my face is swollen'), 'urgent');
});

test('assistant: reviewed answers, personal answers, and "not sure" escalates', () => {
  const db = freshDb();
  const m = mk(db);
  assert.match(assistant.answer('Do I need iron tablets?', m).text, /iron and folic acid/);
  assert.match(assistant.answer('When is my next visit?', m).text, /visit \d of 8/);
  assert.match(assistant.answer('what week am I', m).text, /week 24/);
  const u = assistant.answer('can I dye my hair purple', m);
  assert.equal(u.kind, 'unknown');
  assert.ok(u.acts.includes('escalate'));
  assert.equal(assistant.answer('labour pains', mk(freshDb(), { lmp: isoAgo(140) })).kind, 'emergency', 'preterm labour is an emergency');
});

test('questions: a clinic with a mobile is texted; at most 3 open; demo accounts are never stored', () => {
  const db = freshDb();
  const m = mk(db);
  const r = questions.create(db, m, 'Can I travel to the village?');
  assert.equal(r.notified, true);
  assert.ok(outbox(db).some((o) => o.kind === 'question-facility' && /travel/.test(o.body)));
  questions.create(db, m, 'second'); questions.create(db, m, 'third');
  assert.throws(() => questions.create(db, m, 'fourth'), /waiting/);
  assert.equal(questions.list(db).length, 3);
  assert.ok(questions.handle(db, 1));
});

function withDemo(fn) {
  const old = { ...config.demo };
  config.demo.code = 'Demo-Access-9'; config.demo.phones = '0700000001'; demo.resetFails();
  try { return fn(); } finally { Object.assign(config.demo, old); }
}

test('demo: needs the code, only works for reserved numbers, and never reaches the outside world', () => {
  withDemo(() => {
    const db = freshDb();
    const DP = '+256700000001';
    assert.equal(demo.isDemoPhone(DP), true);
    assert.equal(demo.isDemoPhone('+256712345678'), false, 'a real number can never use the demo code');
    const r = auth.requestOtp(db, DP);
    assert.equal(r.demo, true);
    assert.equal(outbox(db).length, 0, 'no SMS for a demo sign-in');
    assert.ok(auth.verifyOtp(db, DP, 'wrong').error);
    assert.ok(auth.verifyOtp(db, DP, 'Demo-Access-9').token);
    // the code does nothing for a real number
    const real = '+256712345678';
    auth.requestOtp(db, real);
    assert.ok(auth.verifyOtp(db, real, 'Demo-Access-9').error);
    // an emergency from a demo account contacts nobody and stores nothing
    const m = mothers.create(db, { phone: DP, name: 'Tester', lmp: isoAgo(168), facilityId: 1, contactPhone: '+256700111222', channel: 'app' });
    const before = outbox(db).length;
    const a = alerts.createAlert(db, { mother: m, symptoms: ['sos'], channel: 'app' });
    assert.equal(a.demo, true);
    assert.equal(outbox(db).length, before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 0);
    assert.equal(questions.create(db, m, 'test question').demo, true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM questions').get().n, 0);
  });
});

test('demo: disabled when the code is short or no numbers are listed', () => {
  const old = { ...config.demo };
  try {
    config.demo.code = 'short'; config.demo.phones = '0700000001';
    assert.equal(demo.enabled(), false);
    config.demo.code = 'Demo-Access-9'; config.demo.phones = '';
    assert.equal(demo.enabled(), false);
  } finally { Object.assign(config.demo, old); }
});

test('demo: ten wrong codes lock the number', () => {
  withDemo(() => {
    const db = freshDb();
    for (let i = 0; i < 10; i++) demo.check('+256700000001', 'nope-' + i);
    assert.match(auth.verifyOtp(db, '+256700000001', 'Demo-Access-9').error, /Wait 15 minutes/);
  });
});

test('API: chat answers, escalates to the clinic, and demo sign-in works', async (t) => {
  const db = freshDb();
  const m = mk(db);
  const server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (p, { method = 'GET', body, token } = {}) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const token = auth.verifyOtp(db, m.phone, auth.requestOtp(db, m.phone).code).token;
  assert.equal((await api('/api/chat', { method: 'POST', body: { text: 'hi' } })).status, 401);
  assert.equal((await api('/api/chat', { method: 'POST', token, body: { text: 'bleeding' } })).body.kind, 'emergency');
  const e = await api('/api/chat/escalate', { method: 'POST', token, body: { text: 'Is it ok to travel?' } });
  assert.equal(e.status, 200);
  assert.equal(e.body.ok, true);
  assert.equal((await api('/api/chat/escalate', { method: 'POST', token, body: { text: '' } })).status, 400);

  withDemo(() => {});
  config.demo.code = 'Demo-Access-9'; config.demo.phones = '0700000001'; demo.resetFails();
  t.after(() => { config.demo.code = ''; config.demo.phones = ''; });
  const rq = await api('/api/otp/request', { method: 'POST', body: { phone: '0700000001' } });
  assert.equal(rq.body.demo, true);
  const bad = await api('/api/otp/verify', { method: 'POST', body: { phone: '0700000001', code: 'nope' } });
  assert.equal(bad.status, 400);
  const good = await api('/api/otp/verify', { method: 'POST', body: { phone: '0700000001', code: 'Demo-Access-9' } });
  assert.equal(good.status, 200);
  assert.equal((await api('/api/me', { token: good.body.token })).body.demo, true);
});

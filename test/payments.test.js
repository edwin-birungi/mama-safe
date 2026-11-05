'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const payments = require('../src/payments');
const reminders = require('../src/reminders');
const alerts = require('../src/alerts');
const mothers = require('../src/mothers');
const schedule = require('../src/schedule');
const { createServer } = require('../src/server');
const { freshDb, outbox } = require('./helpers');

const LMP = schedule.fmt(schedule.addDays(schedule.parseDate('2026-11-04'), -26 * 7));
const P = config.payments;
const { momo: _m, ...saved } = { ...P, env: config.env };
const savedMomo = { ...P.momo };
const restore = () => { payments.resetMomoToken(); Object.assign(P.momo, savedMomo); Object.assign(P, saved); config.env = saved.env; payments.setFetch((...a) => fetch(...a)); };
function fee(extra = {}) { Object.assign(P, { fee: 43000, currency: 'UGX', publicUrl: 'https://app.test', flwSecretKey: '', flwSecretHash: '', ...extra }); }
const mom = (db) => mothers.create(db, { phone: '+256712345678', name: 'Amina', lmp: LMP, facilityId: 1, contactPhone: '+256700111222', channel: 'app' });

// A fake Flutterwave: records calls and answers from `script`.
function fakeFlw(script) {
  const calls = [];
  payments.setFetch(async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = script(url, opts);
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
  });
  return calls;
}
const verified = (o) => ({ body: { status: 'success', data: { status: 'successful', tx_ref: o.tx_ref, amount: o.amount, currency: o.currency, id: 99 } } });

test('fee off: everyone has access and checkout is refused', async (t) => {
  t.after(restore); fee({ fee: 0 });
  const db = freshDb(); const m = mom(db);
  assert.equal(payments.hasAccess(db, m.id), true);
  await assert.rejects(() => payments.checkout(db, m), /not turned on/);
});

test('fee on: reminders wait for payment, emergency alerts never do', async (t) => {
  t.after(restore); fee();
  const db = freshDb(); const m = mom(db);
  assert.equal(reminders.run(db, new Date('2026-11-01T07:00:00Z')), 0); // unpaid: no reminder
  const r = alerts.createAlert(db, { mother: m, symptoms: ['sos'], channel: 'sms' }); // unpaid: alert still goes
  assert.ok(r.alert.id);
  assert.ok(outbox(db).some((o) => o.kind === 'alert-mother'));
  const c = await payments.checkout(db, m); // dev mock checkout
  assert.ok(c.mock && c.link.startsWith('https://app.test/pay/mock?tx_ref=MS-'));
  assert.equal(payments.mockComplete(db, c.txRef, true).status, 'successful');
  assert.equal(payments.hasAccess(db, m.id), true);
  assert.equal(reminders.run(db, new Date('2026-11-03T07:00:00Z')), 1);
  await assert.rejects(() => payments.checkout(db, m), /already paid/);
});

test('staff can waive the fee', (t) => {
  t.after(restore); fee();
  const db = freshDb(); const m = mom(db);
  assert.equal(payments.summary(db, m.id).paid, false);
  payments.waive(db, m.id, 'dashboard', 'sponsored by clinic');
  const s = payments.summary(db, m.id);
  assert.ok(s.paid && s.waived);
});

test('production without Flutterwave keys refuses to take payments (no fake success)', async (t) => {
  t.after(restore); fee(); config.env = 'production';
  const db = freshDb(); const m = mom(db);
  await assert.rejects(() => payments.checkout(db, m), /not set up/);
  assert.equal(payments.mockComplete(db, 'x', true).status, 'unknown');
});

test('Flutterwave checkout sends the right request and verification credits exactly once', async (t) => {
  t.after(restore); fee({ flwSecretKey: 'FLWSECK_TEST-abc' });
  const db = freshDb(); const m = mom(db);
  let order;
  const calls = fakeFlw((url) => {
    if (url.endsWith('/payments')) return { body: { status: 'success', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/xyz' } } };
    return verified(order);
  });
  const c = await payments.checkout(db, m);
  assert.equal(c.link, 'https://checkout.flutterwave.com/v3/hosted/pay/xyz');
  const req = calls[0];
  assert.equal(req.url, 'https://api.flutterwave.com/v3/payments');
  assert.equal(req.opts.headers.Authorization, 'Bearer FLWSECK_TEST-abc');
  const sent = JSON.parse(req.opts.body);
  assert.equal(sent.amount, 43000);
  assert.equal(sent.currency, 'UGX');
  assert.equal(sent.payment_options, 'card,mobilemoneyuganda');
  assert.equal(sent.redirect_url, 'https://app.test/pay/return');
  assert.equal(sent.customer.email, '256712345678@example.com');
  assert.ok(!JSON.stringify(sent).includes('FLWSECK')); // the secret never travels in the body
  order = db.prepare('SELECT * FROM payments WHERE tx_ref = ?').get(c.txRef);
  assert.equal(order.status, 'pending');
  assert.equal((await payments.verify(db, c.txRef)).status, 'successful');
  const n = calls.length;
  assert.equal((await payments.verify(db, c.txRef)).status, 'successful');
  assert.equal(calls.length, n); // already settled: no second credit, no extra API call
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments WHERE status='successful'").get().n, 1);
});

test('verification rejects underpayment, wrong currency and failed payments', async (t) => {
  t.after(restore); fee({ flwSecretKey: 'k' });
  const db = freshDb(); const m = mom(db);
  for (const [bad, expect] of [[{ amount: 100 }, 'failed'], [{ currency: 'USD' }, 'failed'], [{ status: 'failed' }, 'failed'], [{ status: 'pending' }, 'pending']]) {
    let order;
    fakeFlw((url) => (url.endsWith('/payments') ? { body: { status: 'success', data: { link: 'https://x' } } } : { body: { status: 'success', data: { ...verified(order).body.data, ...bad } } }));
    const c = await payments.checkout(db, m);
    order = db.prepare('SELECT * FROM payments WHERE tx_ref = ?').get(c.txRef);
    assert.equal((await payments.verify(db, c.txRef)).status, expect, JSON.stringify(bad));
    assert.equal(payments.hasAccess(db, m.id), false);
  }
  // a tx_ref that does not match what we asked for is not accepted either
  let order2;
  fakeFlw((url) => (url.endsWith('/payments') ? { body: { status: 'success', data: { link: 'https://x' } } } : { body: { status: 'success', data: { ...verified(order2).body.data, tx_ref: 'SOMEONE-ELSE' } } }));
  const c2 = await payments.checkout(db, m);
  order2 = db.prepare('SELECT * FROM payments WHERE tx_ref = ?').get(c2.txRef);
  assert.equal((await payments.verify(db, c2.txRef)).status, 'failed');
});

test('a refused checkout is recorded as failed and reported kindly', async (t) => {
  t.after(restore); fee({ flwSecretKey: 'k' });
  const db = freshDb(); const m = mom(db);
  fakeFlw(() => ({ ok: false, status: 400, body: { status: 'error', message: 'bad key' } }));
  await assert.rejects(() => payments.checkout(db, m), /could not start the payment/);
  assert.equal(db.prepare("SELECT status FROM payments").get().status, 'failed');
});

test('webhook needs the secret hash, then still verifies with Flutterwave', async (t) => {
  t.after(restore); fee({ flwSecretKey: 'k', flwSecretHash: 'my-hash' });
  const db = freshDb(); const m = mom(db);
  let order;
  const calls = fakeFlw((url) => (url.endsWith('/payments') ? { body: { status: 'success', data: { link: 'https://x' } } } : verified(order)));
  const c = await payments.checkout(db, m);
  order = db.prepare('SELECT * FROM payments WHERE tx_ref = ?').get(c.txRef);
  const evt = { event: 'charge.completed', data: { tx_ref: c.txRef, status: 'successful', amount: 1 } }; // body lies about amount
  assert.equal((await payments.webhook(db, {}, evt)).status, 401);
  assert.equal((await payments.webhook(db, { 'verif-hash': 'wrong' }, evt)).status, 401);
  assert.equal(payments.hasAccess(db, m.id), false);
  assert.equal((await payments.webhook(db, { 'verif-hash': 'my-hash' }, evt)).status, 200);
  assert.equal(payments.hasAccess(db, m.id), true);
  P.flwSecretHash = '';
  assert.equal((await payments.webhook(db, { 'verif-hash': '' }, evt)).status, 503); // never accept unsigned webhooks
  fakeFlw(() => ({ ok: false, status: 500, body: {} }));
  const m2 = mothers.create(db, { phone: '+256799000111', lmp: LMP, channel: 'app' });
  P.flwSecretHash = 'h'; P.flwSecretKey = 'k';
  fakeFlw((url) => (url.endsWith('/payments') ? { body: { status: 'success', data: { link: 'https://x' } } } : { ok: false, status: 502, body: {} }));
  const c2 = await payments.checkout(db, m2);
  assert.equal((await payments.webhook(db, { 'verif-hash': 'h' }, { data: { tx_ref: c2.txRef } })).status, 500); // Flutterwave will retry
  assert.ok(calls.length > 0);
});

test('HTTP: checkout needs sign-in, /pay/return ignores the URL status, mock page is dev-only', async (t) => {
  t.after(restore); fee();
  const db = freshDb();
  const server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });

  assert.equal((await post('/api/payments/checkout')).status, 401);

  // sign in + register through the real endpoints
  const otp = await (await post('/api/otp/request', { phone: '0712345678' })).json();
  const { token } = await (await post('/api/otp/verify', { phone: '0712345678', code: otp.devCode })).json();
  assert.equal((await post('/api/payments/checkout', {}, token)).status, 404); // not registered yet
  const reg = await post('/api/register', { lmp: schedule.fmt(schedule.addDays(schedule.localToday(), -60)) }, token);
  const me = await reg.json();
  assert.equal(me.payment.required, true);
  assert.equal(me.payment.paid, false);
  assert.equal(me.payment.amount, 43000);
  assert.match(outbox(db).find((o) => o.kind === 'welcome').body, /pay UGX 43,000.*text PAY.*Emergency help is always free/);

  const co = await (await post('/api/payments/checkout', {}, token)).json();
  assert.ok(co.mock && co.link.includes('/pay/mock'));

  // A forged return URL claiming success must not unlock anything.
  const ref = new URL(co.link).searchParams.get('tx_ref');
  const ret = await fetch(`${base}/pay/return?tx_ref=${ref}&status=successful`, { redirect: 'manual' });
  assert.equal(ret.status, 302);
  assert.match(ret.headers.get('location'), /payment=pending/);
  assert.equal(db.prepare("SELECT status FROM payments WHERE tx_ref = ?").get(ref).status, 'pending');

  // Dev mock page completes it.
  const ok = await fetch(co.link.replace('https://app.test', base), { redirect: 'manual' });
  assert.match(ok.headers.get('location'), /payment=success/);
  assert.equal((await (await fetch(base + '/api/payments/status', { headers: { Authorization: 'Bearer ' + token } })).json()).paid, true);

  config.env = 'production';
  assert.equal((await fetch(`${base}/pay/mock?tx_ref=${ref}`, { redirect: 'manual' })).status, 404);
});

// ---------------- MTN MoMo Request to Pay ----------------
const ussd = require('../src/ussd');
const smsCommands = require('../src/smsCommands');
const tick = () => new Promise((r) => setImmediate(r));
function momoOn(extra = {}) {
  fee({ publicUrl: 'https://app.test', currency: 'UGX' });
  Object.assign(P.momo, { subscriptionKey: 'SUBKEY', apiUser: 'user-1', apiKey: 'key-1', targetEnv: 'mtnuganda', baseUrl: 'https://proxy.momoapi.mtn.com', callbackKey: 'cb-secret', ...extra });
  payments.resetMomoToken();
}
// Fake MTN: `status` is what the status endpoint answers for any reference.
function fakeMtn(state = {}) {
  const calls = [];
  payments.setFetch(async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body || {} });
    if (url.endsWith('/collection/token/')) return reply(200, { access_token: 'TOK', expires_in: 3600 });
    if (url.endsWith('/collection/v1_0/requesttopay')) return reply(state.pushStatus || 202);
    if (url.includes('/collection/v1_0/requesttopay/')) {
      const ref = decodeURIComponent(url.split('/').pop());
      return reply(200, { amount: '43000', currency: 'UGX', externalId: ref, status: 'SUCCESSFUL', financialTransactionId: 'FT1', ...(state.status || {}) });
    }
    return reply(404);
  });
  return calls;
}

test('MTN: sends a correct Request to Pay, then confirms with MTN and credits once', async (t) => {
  t.after(restore); momoOn();
  const db = freshDb(); const m = mom(db);
  const calls = fakeMtn();
  const r = await payments.momoPush(db, m, '0772 123 456');
  assert.equal(r.payer, '+256772123456');
  const [tok, req] = calls;
  assert.equal(tok.url, 'https://proxy.momoapi.mtn.com/collection/token/');
  assert.equal(tok.opts.headers.Authorization, 'Basic ' + Buffer.from('user-1:key-1').toString('base64'));
  assert.equal(tok.opts.headers['Ocp-Apim-Subscription-Key'], 'SUBKEY');
  assert.equal(req.url, 'https://proxy.momoapi.mtn.com/collection/v1_0/requesttopay');
  assert.equal(req.opts.headers.Authorization, 'Bearer TOK');
  assert.equal(req.opts.headers['X-Target-Environment'], 'mtnuganda');
  assert.match(req.opts.headers['X-Reference-Id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(req.opts.headers['X-Callback-Url'], 'https://app.test/webhooks/momo/cb-secret');
  assert.deepEqual(req.body.payer, { partyIdType: 'MSISDN', partyId: '256772123456' });
  assert.equal(req.body.amount, '43000');
  assert.equal(req.body.currency, 'UGX');
  assert.equal(req.body.externalId, req.opts.headers['X-Reference-Id']);
  assert.equal(payments.hasAccess(db, m.id), false);

  assert.equal((await payments.pollOpen(db, m.id)).status, 'successful');
  assert.equal(payments.hasAccess(db, m.id), true);
  assert.equal(outbox(db).filter((o) => o.kind === 'payment').length, 1); // thanked once
  await payments.verify(db, r.txRef); await payments.pollOpen(db, m.id);
  assert.equal(outbox(db).filter((o) => o.kind === 'payment').length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith('/collection/token/')).length, 1); // token reused
});

test('MTN: pending stays pending; failed, underpaid and wrong-reference payments never unlock', async (t) => {
  t.after(restore); momoOn();
  const db = freshDb(); const m = mom(db);
  for (const [status, expect] of [[{ status: 'PENDING' }, 'pending'], [{ status: 'FAILED', reason: 'PAYER_NOT_FOUND' }, 'failed'], [{ amount: '100' }, 'failed'], [{ currency: 'EUR' }, 'failed'], [{ externalId: 'other' }, 'failed']]) {
    const calls = fakeMtn({ status });
    db.prepare("UPDATE payments SET created_at = '2000-01-01T00:00:00Z'").run(); // not "recent" so a new prompt is made
    await payments.momoPush(db, m);
    assert.equal((await payments.pollOpen(db, m.id)).status, expect, JSON.stringify(status));
    assert.equal(payments.hasAccess(db, m.id), false);
    assert.ok(calls.length >= 2);
  }
});

test('MTN: refusals are recorded; Airtel and bad numbers are rejected before any request', async (t) => {
  t.after(restore); momoOn();
  const db = freshDb(); const m = mom(db);
  let calls = fakeMtn({ pushStatus: 500 });
  await assert.rejects(() => payments.momoPush(db, m), /could not send the payment prompt/);
  assert.equal(db.prepare("SELECT status FROM payments").get().status, 'failed');
  calls = fakeMtn();
  assert.match(payments.canPush(db, m, '0701234567').error, /Airtel Money payments are not set up/); // MTN is configured, Airtel is not
  assert.match(payments.canPush(db, m, '12').error, /not valid/);
  assert.equal(calls.length, 0);
});

test('MTN: a second tap within two minutes reuses the open prompt instead of spamming the phone', async (t) => {
  t.after(restore); momoOn();
  const db = freshDb(); const m = mom(db);
  const calls = fakeMtn();
  const a = await payments.momoPush(db, m);
  const b = await payments.momoPush(db, m);
  assert.equal(b.txRef, a.txRef);
  assert.equal(calls.filter((c) => c.url.endsWith('/requesttopay')).length, 1);
});

test('MTN callback: needs the secret path key and is only a hint to go and ask MTN', async (t) => {
  t.after(restore); momoOn();
  const db = freshDb(); const m = mom(db);
  fakeMtn({ status: { status: 'PENDING' } });
  const r = await payments.momoPush(db, m);
  const lie = { externalId: r.txRef, status: 'SUCCESSFUL', amount: '43000', currency: 'UGX' };
  assert.equal((await payments.momoCallback(db, 'wrong', lie)).status, 401);
  assert.equal((await payments.momoCallback(db, 'cb-secret', lie)).status, 200);
  assert.equal(payments.hasAccess(db, m.id), false); // MTN says PENDING, so the callback's claim counts for nothing
  fakeMtn();
  assert.equal((await payments.momoCallback(db, 'cb-secret', lie)).status, 200);
  assert.equal(payments.hasAccess(db, m.id), true);
  P.momo.callbackKey = '';
  assert.equal((await payments.momoCallback(db, '', lie)).status, 503);
});

test('production without MTN credentials refuses instead of faking a payment', async (t) => {
  t.after(restore); fee(); config.env = 'production';
  const db = freshDb(); const m = mom(db);
  assert.equal(payments.canPush(db, m).status, 503);
});

test('development test mode: a prompt settles itself so the whole flow can be tried', async (t) => {
  t.after(restore); fee();
  const db = freshDb(); const m = mom(db);
  const r = await payments.momoPush(db, m);
  assert.ok(r.mock);
  assert.equal((await payments.pollOpen(db, m.id)).status, 'successful');
  assert.equal(payments.hasAccess(db, m.id), true);
});

test('USSD: "Pay fee" appears only when a fee is due, and sends the prompt', async (t) => {
  t.after(restore); momoOn();
  const db = freshDb(); const m = mom(db);
  const calls = fakeMtn();
  const dial = (text) => ussd.handle(db, { phone: '+256712345678', text });
  assert.match(dial(''), /5\. Find a hospital\n6\. Pay fee/);
  assert.match(dial('6'), /^CON Pay UGX 43,000.*\n1\. Pay with this number\n2\. Another number\n0\. Back/s);
  assert.match(dial('6*2'), /^CON Type the MTN or Airtel Money number/);
  assert.match(dial('6*2*0701234567'), /^END Airtel Money payments are not set up/);
  assert.match(dial('6*2*12'), /^CON Invalid number/);
  const out = dial('6*2*0772123456');
  assert.match(out, /^END A payment prompt is coming to 0772123456/);
  await tick(); await tick(); await tick();
  assert.equal(calls.filter((c) => c.url.endsWith('/requesttopay')).length, 1);
  for (const s of ['', '6', '6*2']) assert.ok(dial(s).length <= 200, 'fits a USSD screen');
  await payments.pollOpen(db, m.id);
  assert.doesNotMatch(dial(''), /Pay fee/);
});

test('USSD: if MTN refuses, the mother is told by SMS', async (t) => {
  t.after(restore); momoOn();
  const db = freshDb(); mom(db);
  fakeMtn({ pushStatus: 500 });
  ussd.handle(db, { phone: '+256712345678', text: '6*1' });
  for (let i = 0; i < 6; i++) await tick();
  assert.match(outbox(db).find((o) => o.kind === 'payment').body, /could not send the payment prompt/);
});

test('SMS: PAY sends a prompt; a fee-free service says so', async (t) => {
  t.after(restore); momoOn();
  const db = freshDb(); mom(db);
  const calls = fakeMtn();
  const reply = smsCommands.handle(db, { from: '+256712345678', text: 'PAY' });
  assert.match(reply, /prompt is coming to 0712345678.*UGX 43,000.*Emergency help is always free/);
  await tick(); await tick(); await tick();
  assert.equal(calls.filter((c) => c.url.endsWith('/requesttopay')).length, 1);
  fee({ fee: 0 });
  assert.match(smsCommands.handle(db, { from: '+256712345678', text: 'PAY' }), /not turned on/);
});

test('HTTP: MTN push and status polling work end to end for the web app', async (t) => {
  t.after(restore); momoOn();
  const db = freshDb();
  const server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const real = fetch;
  const mtn = fakeMtn();
  // route only MTN calls to the fake; our own server calls go through the real fetch
  payments.setFetch((url, opts) => (String(url).startsWith(base) ? real(url, opts) : (mtn.length, mtnFetch(url, opts))));
  let mtnFetch; { const calls = []; mtnFetch = async (url, opts = {}) => { calls.push(url);
    const rep = (s, b) => ({ ok: s < 300, status: s, json: async () => b || {} });
    if (url.endsWith('/collection/token/')) return rep(200, { access_token: 'T', expires_in: 3600 });
    if (url.endsWith('/requesttopay')) return rep(202);
    return rep(200, { amount: '43000', currency: 'UGX', externalId: decodeURIComponent(url.split('/').pop()), status: 'SUCCESSFUL', financialTransactionId: 'F' }); }; }
  const j = (path, body, token, method = body ? 'POST' : 'GET') => real(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const otp = (await j('/api/otp/request', { phone: '0712345678' })).body;
  const { token } = (await j('/api/otp/verify', { phone: '0712345678', code: otp.devCode })).body;
  await j('/api/register', { lmp: schedule.fmt(schedule.addDays(schedule.localToday(), -60)) }, token);
  assert.equal((await j('/api/payments/momo', { phone: '0701234567' }, token)).status, 503); // Airtel not configured here
  const push = await j('/api/payments/momo', {}, token);
  assert.equal(push.status, 200);
  assert.equal(push.body.payer, '+256712345678');
  const st = await j('/api/payments/status', null, token);
  assert.equal(st.body.paid, true);
  assert.equal(st.body.last, 'successful');
  // MTN callback route (PUT) with the secret key
  assert.equal((await j('/webhooks/momo/nope', { externalId: 'x' }, null, 'PUT')).status, 401);
  assert.equal((await j('/webhooks/momo/cb-secret', { externalId: 'unknown' }, null, 'PUT')).status, 200);
});

// ---------------- Airtel Money ----------------
function airtelOn(extra = {}) {
  fee({ publicUrl: 'https://app.test', currency: 'UGX' });
  Object.assign(P.airtel, { clientId: 'cid', clientSecret: 'csec', targetEnv: 'production', baseUrl: 'https://openapi.airtel.africa', country: 'UG', callbackKey: 'air-secret', ...extra });
  payments.resetMomoToken();
}
const savedAirtel = { ...P.airtel };
function fakeAirtel(state = {}) {
  const calls = [];
  payments.setFetch(async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body || {} });
    if (url.endsWith('/auth/oauth2/token')) return reply(200, { access_token: 'ATOK', expires_in: 3600, token_type: 'bearer' });
    if (url.endsWith('/merchant/v2/payments/')) return state.pushFail ? reply(200, { status: { success: false, code: '400' } }) : reply(200, { data: { transaction: { status: 'SUCCESS' } }, status: { code: '200', success: true } });
    if (url.includes('/standard/v1/payments/')) {
      const id = decodeURIComponent(url.split('/').pop());
      return reply(200, { data: { transaction: { id, status: 'TS', message: 'Paid', airtel_money_id: 'CI1.2' } }, status: { success: true }, ...(state.status ? { data: { transaction: { id, ...state.status } } } : {}) });
    }
    return reply(404);
  });
  return calls;
}
test.afterEach(() => { Object.assign(P.airtel, savedAirtel); });

test('Airtel: sends a correct USSD-push request and confirms with Airtel before crediting', async (t) => {
  t.after(restore); airtelOn();
  const db = freshDb(); const m = mom(db);
  const calls = fakeAirtel();
  const r = await payments.momoPush(db, m, '0701 234 567');
  assert.equal(r.operator, 'airtel');
  const [tok, req] = calls;
  assert.equal(tok.url, 'https://openapi.airtel.africa/auth/oauth2/token');
  assert.deepEqual(tok.body, { client_id: 'cid', client_secret: 'csec', grant_type: 'client_credentials' });
  assert.equal(req.url, 'https://openapi.airtel.africa/merchant/v2/payments/');
  assert.equal(req.opts.headers.Authorization, 'Bearer ATOK');
  assert.equal(req.opts.headers['X-Country'], 'UG');
  assert.equal(req.opts.headers['X-Currency'], 'UGX');
  assert.equal(req.body.subscriber.msisdn, '701234567'); // national number, no country code
  assert.equal(req.body.transaction.amount, 43000);
  assert.equal(req.body.transaction.id, r.txRef);
  assert.match(r.txRef, /^MS[0-9a-f]{20}$/);
  assert.equal(payments.hasAccess(db, m.id), false); // the push response proves nothing
  assert.equal((await payments.pollOpen(db, m.id)).status, 'successful');
  assert.equal(payments.hasAccess(db, m.id), true);
  assert.equal(db.prepare('SELECT provider_ref FROM payments WHERE tx_ref = ?').get(r.txRef).provider_ref, 'CI1.2');
  assert.equal(outbox(db).filter((o) => o.kind === 'payment').length, 1);
});

test('Airtel: failed, in-progress and ambiguous prompts never unlock; a refused request is recorded', async (t) => {
  t.after(restore); airtelOn();
  const db = freshDb(); const m = mom(db);
  for (const [status, expect] of [[{ status: 'TF', message: 'Insufficient funds' }, 'failed'], [{ status: 'TIP' }, 'pending'], [{ status: 'TA' }, 'pending'], [{ id: 'other', status: 'TS' }, 'pending']]) {
    fakeAirtel({ status });
    db.prepare("UPDATE payments SET created_at = '2000-01-01T00:00:00Z'").run();
    await payments.momoPush(db, m, '0751234567');
    assert.equal((await payments.pollOpen(db, m.id)).status, expect, JSON.stringify(status));
    assert.equal(payments.hasAccess(db, m.id), false);
  }
  fakeAirtel({ pushFail: true });
  db.prepare("UPDATE payments SET created_at = '2000-01-01T00:00:00Z'").run();
  await assert.rejects(() => payments.momoPush(db, m, '0751234567'), /could not send the payment prompt/);
});

test('Airtel callback: secret key required and the body is only a hint', async (t) => {
  t.after(restore); airtelOn();
  const db = freshDb(); const m = mom(db);
  fakeAirtel({ status: { status: 'TIP' } });
  const r = await payments.momoPush(db, m, '0701234567');
  const lie = { transaction: { id: r.txRef, status_code: 'TS' } };
  assert.equal((await payments.airtelCallback(db, 'nope', lie)).status, 401);
  assert.equal((await payments.airtelCallback(db, 'air-secret', lie)).status, 200);
  assert.equal(payments.hasAccess(db, m.id), false);
  fakeAirtel();
  assert.equal((await payments.airtelCallback(db, 'air-secret', lie)).status, 200);
  assert.equal(payments.hasAccess(db, m.id), true);
  P.airtel.callbackKey = '';
  assert.equal((await payments.airtelCallback(db, '', lie)).status, 503);
});

test('Both networks configured: each number goes to its own operator', async (t) => {
  t.after(restore); momoOn(); airtelOn();
  const db = freshDb(); const m = mom(db);
  const urls = [];
  payments.setFetch(async (url, opts = {}) => {
    urls.push(url);
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body || {} });
    if (url.endsWith('/collection/token/')) return reply(200, { access_token: 'T', expires_in: 3600 });
    if (url.endsWith('/auth/oauth2/token')) return reply(200, { access_token: 'A', expires_in: 3600 });
    if (url.endsWith('/requesttopay')) return reply(202);
    return reply(200, { status: { success: true } });
  });
  assert.equal((await payments.momoPush(db, m, '0772123456')).operator, 'mtn');
  db.prepare("UPDATE payments SET created_at = '2000-01-01T00:00:00Z'").run();
  assert.equal((await payments.momoPush(db, m, '0752123456')).operator, 'airtel');
  assert.ok(urls.some((u) => u.includes('proxy.momoapi.mtn.com')) && urls.some((u) => u.includes('openapi.airtel.africa')));
  assert.deepEqual(payments.summary(db, m.id).networks, ['MTN', 'Airtel']);
});

test('USSD and SMS: an Airtel number gets an Airtel prompt', async (t) => {
  t.after(restore); airtelOn();
  const db = freshDb(); mom(db);
  const calls = fakeAirtel();
  assert.match(ussd.handle(db, { phone: '+256712345678', text: '6*2*0701234567' }), /^END A payment prompt is coming to 0701234567/);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(calls.filter((c) => c.url.endsWith('/merchant/v2/payments/')).length, 1);
  db.prepare("UPDATE payments SET created_at = '2000-01-01T00:00:00Z'").run();
  assert.match(smsCommands.handle(db, { from: '+256712345678', text: 'PAY 0751234567' }), /prompt is coming to 0751234567/);
});

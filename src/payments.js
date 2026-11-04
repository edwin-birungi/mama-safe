'use strict';
// Optional enrolment fee, paid by mobile money (MTN / Airtel) or card through Flutterwave's HOSTED
// checkout. Card numbers and mobile-money PINs are entered on Flutterwave's page, never on ours, so
// this server never sees them.
//
// SAFETY RULE: payment never blocks emergency help. Alerts, the danger-sign check and the hospital
// finder do not call into this module. Only SMS visit reminders are held back until a mother has paid
// (or been waived by staff).
//
// We never trust the browser or the webhook body to say a payment succeeded: we ask Flutterwave
// directly (verify_by_reference) and compare reference, amount and currency with our own record.

const crypto = require('crypto');
const config = require('./config');
const { safeEqual } = require('./auth');
const sms = require('./sms');

const API = 'https://api.flutterwave.com/v3';
let http = (...a) => fetch(...a);
const setFetch = (f) => { http = f; }; // tests inject a fake

const required = () => config.payments.fee > 0;
const live = () => !!config.payments.flwSecretKey;
const airtelLive = () => { const a = config.payments.airtel; return !!(a.clientId && a.clientSecret); };
const mobileLive = () => momoLive() || airtelLive();
const momoLive = () => { const m = config.payments.momo; return !!(m.subscriptionKey && m.apiUser && m.apiKey); };
const now = () => new Date().toISOString();

function summary(db, motherId) {
  const p = config.payments;
  const done = db.prepare("SELECT provider, status FROM payments WHERE mother_id = ? AND status IN ('successful','waived') ORDER BY id DESC LIMIT 1").get(motherId);
  return {
    required: required(), amount: p.fee, currency: p.currency,
    paid: !required() || !!done, waived: !!done && done.status === 'waived',
    // which ways to pay are available right now
    hosted: live() || (config.env !== 'production' && !mobileLive()),
    momo: mobileLive() || (config.env !== 'production' && !live()),   // a prompt on the phone (MTN or Airtel)
    networks: [momoLive() && 'MTN', airtelLive() && 'Airtel'].filter(Boolean)
  };
}

// True when this mother has full access (fee off, paid, or waived). Only reminders consult this.
const hasAccess = (db, motherId) => summary(db, motherId).paid;

function newRef() { return 'MS-' + Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex'); }

// Mark a pending order successful exactly once; only the first call thanks the mother by SMS.
function settle(db, txRef, providerRef) {
  const r = db.prepare("UPDATE payments SET status = 'successful', provider_ref = ?, paid_at = ? WHERE tx_ref = ? AND status = 'pending'")
    .run(String(providerRef || ''), now(), txRef);
  if (r.changes) {
    const m = db.prepare('SELECT m.phone FROM payments p JOIN mothers m ON m.id = p.mother_id WHERE p.tx_ref = ?').get(txRef);
    if (m) sms.send(db, m.phone, 'MamaSafe: payment received, thank you. Your visit reminders are now on. Emergency help is always free.', 'payment');
  }
}

// Start a payment. Returns { link, txRef }. The mother is sent to `link` to pay.
async function checkout(db, mother, { email } = {}) {
  if (!required()) throw Object.assign(new Error('Payments are not turned on.'), { status: 400 });
  if (hasAccess(db, mother.id)) throw Object.assign(new Error('You have already paid. Thank you.'), { status: 409 });
  const p = config.payments;
  const txRef = newRef();
  const provider = live() ? 'flutterwave' : 'mock';
  if (!live() && config.env === 'production') {
    throw Object.assign(new Error('Payments are not set up yet. Please ask your clinic.'), { status: 503 });
  }
  db.prepare('INSERT INTO payments (tx_ref, mother_id, amount, currency, provider, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(txRef, mother.id, p.fee, p.currency, provider, 'pending', now());

  if (provider === 'mock') return { txRef, link: `${p.publicUrl}/pay/mock?tx_ref=${encodeURIComponent(txRef)}`, mock: true };

  const digits = mother.phone.replace(/\D/g, '');
  const res = await http(API + '/payments', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + p.flwSecretKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tx_ref: txRef, amount: p.fee, currency: p.currency,
      redirect_url: `${p.publicUrl}/pay/return`,
      payment_options: p.options,
      customer: { email: email || `${digits}@${p.emailDomain}`, phonenumber: mother.phone, name: mother.name || 'MamaSafe mother' },
      customizations: { title: 'MamaSafe', description: 'MamaSafe enrolment' },
      meta: { mother_id: mother.id }
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'success' || !body.data || !body.data.link) {
    db.prepare("UPDATE payments SET status = 'failed', note = ? WHERE tx_ref = ?").run('checkout refused: ' + String(body.message || res.status).slice(0, 200), txRef);
    throw Object.assign(new Error('We could not start the payment. Please try again.'), { status: 502 });
  }
  return { txRef, link: body.data.link };
}

// Ask Flutterwave what really happened to this reference and update our record.
// Idempotent: a payment is credited at most once, however many times this runs.
async function verify(db, txRef) {
  const order = db.prepare('SELECT * FROM payments WHERE tx_ref = ?').get(txRef);
  if (!order) return { status: 'unknown' };
  if (order.status !== 'pending') return { status: order.status };
  if (order.provider === 'momo') return verifyMomo(db, order);
  if (order.provider === 'airtel') return verifyAirtel(db, order);
  if (order.provider !== 'flutterwave') return { status: order.status };
  const res = await http(`${API}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`, {
    headers: { Authorization: 'Bearer ' + config.payments.flwSecretKey }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('verify failed: ' + res.status); // transient: caller may retry
  const d = body.data;
  if (!d) return { status: 'pending' }; // not found yet
  if (d.status === 'successful') {
    const ok = d.tx_ref === txRef && Number(d.amount) >= order.amount && d.currency === order.currency;
    if (!ok) {
      db.prepare("UPDATE payments SET status = 'failed', note = ? WHERE tx_ref = ? AND status = 'pending'")
        .run(`mismatch: got ${d.amount} ${d.currency}`, txRef);
      return { status: 'failed' };
    }
    settle(db, txRef, d.id || d.flw_ref);
    return { status: 'successful' };
  }
  if (d.status === 'failed' || d.status === 'cancelled') {
    db.prepare("UPDATE payments SET status = 'failed', note = ? WHERE tx_ref = ? AND status = 'pending'").run(String(d.status), txRef);
    return { status: 'failed' };
  }
  return { status: 'pending' };
}

// Flutterwave calls us when a payment finishes. Authenticity: the `verif-hash` header must equal the
// secret hash you set in the Flutterwave dashboard. Even then we re-verify with their API.
async function webhook(db, headers, body) {
  const secret = config.payments.flwSecretHash;
  if (!secret) return { status: 503, text: 'Webhook secret not configured' };
  if (!safeEqual(headers['verif-hash'] || '', secret)) return { status: 401, text: 'Bad signature' };
  const ref = body && body.data && (body.data.tx_ref || body.txRef);
  if (!ref) return { status: 200, text: 'ignored' };
  try { await verify(db, ref); } catch { return { status: 500, text: 'retry' }; }
  return { status: 200, text: 'OK' };
}


// ---------- MTN MoMo "Request to Pay" ----------
// We ask MTN to put a payment prompt on the mother's phone. She enters her MoMo PIN there, so we
// never see it. MTN callbacks are not signed, so a callback only tells us WHEN to check: we always
// confirm by asking MTN for the transaction status ourselves.

// MTN Uganda numbers start 077, 078, 076 or 039; Airtel starts 070, 074, 075. (Numbers can move between
// networks; if the prompt goes to the wrong one the operator refuses it and the mother is told by SMS.)
const AIRTEL_PREFIX = /^\+256(70|74|75)\d{7}$/;
const operatorOf = (payer) => (AIRTEL_PREFIX.test(payer) ? 'airtel' : 'mtn');
let momoToken = { value: '', exp: 0 };

async function momoAuth() {
  if (momoToken.value && Date.now() < momoToken.exp - 60000) return momoToken.value;
  const m = config.payments.momo;
  const res = await http(`${m.baseUrl}/collection/token/`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${m.apiUser}:${m.apiKey}`).toString('base64'),
      'Ocp-Apim-Subscription-Key': m.subscriptionKey
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error('MoMo token failed: ' + res.status);
  momoToken = { value: body.access_token, exp: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return momoToken.value;
}
const momoHeaders = (token) => ({
  Authorization: 'Bearer ' + token, 'X-Target-Environment': config.payments.momo.targetEnv,
  'Ocp-Apim-Subscription-Key': config.payments.momo.subscriptionKey
});

// Checks that a prompt can be sent. Returns { payer } or { error, status }. Synchronous, so USSD can
// answer the mother at once.
function canPush(db, mother, payerPhone) {
  const fail = (error, status) => ({ error, status });
  if (!required()) return fail('Payments are not turned on.', 400);
  if (hasAccess(db, mother.id)) return fail('You have already paid. Thank you.', 409);
  const payer = require('./phone').normalizePhone(payerPhone || mother.phone);
  if (!payer) return fail('That phone number is not valid.', 400);
  const op = operatorOf(payer);
  const opLive = op === 'airtel' ? airtelLive() : momoLive();
  if (!opLive && (config.env === 'production' || mobileLive())) {
    return fail(`${op === 'airtel' ? 'Airtel Money' : 'MTN MoMo'} payments are not set up yet. Please ask your clinic.`, 503);
  }
  return { payer };
}

// Push a payment prompt to `payerPhone` (defaults to the mother's own number).
async function momoPush(db, mother, payerPhone) {
  const c = canPush(db, mother, payerPhone);
  if (c.error) throw Object.assign(new Error(c.error), { status: c.status });
  const payer = c.payer;
  // one open prompt at a time: re-use a recent pending one rather than spamming the phone
  const open = db.prepare("SELECT * FROM payments WHERE mother_id = ? AND provider IN ('momo','airtel','mockmomo') AND status = 'pending' AND created_at > ? ORDER BY id DESC LIMIT 1")
    .get(mother.id, new Date(Date.now() - 2 * 60000).toISOString());
  if (open) return { txRef: open.tx_ref, payer, reused: true };

  const p = config.payments;
  const op = operatorOf(payer);
  const provider = op === 'airtel' ? (airtelLive() ? 'airtel' : 'mockmomo') : (momoLive() ? 'momo' : 'mockmomo');
  // MTN needs a UUID v4 as reference; Airtel wants a short unique id. Both double as our own reference.
  const txRef = op === 'airtel' ? 'MS' + crypto.randomBytes(10).toString('hex') : crypto.randomUUID();
  db.prepare('INSERT INTO payments (tx_ref, mother_id, amount, currency, provider, status, note, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(txRef, mother.id, p.fee, p.currency, provider, 'pending', `payer ${payer}`, now());
  if (provider === 'mockmomo') return { txRef, payer, mock: true, operator: op };

  try {
    if (provider === 'airtel') await sendAirtel(txRef, payer); else await sendMtn(txRef, payer);
  } catch (e) {
    db.prepare("UPDATE payments SET status = 'failed', note = ? WHERE tx_ref = ?").run(String(e.message).slice(0, 200), txRef);
    throw Object.assign(new Error('We could not send the payment prompt. Please try again.'), { status: 502 });
  }
  return { txRef, payer, operator: op };
}

async function sendMtn(txRef, payer) {
  const p = config.payments;
  const token = await momoAuth();
  const res = await http(`${p.momo.baseUrl}/collection/v1_0/requesttopay`, {
    method: 'POST',
    headers: {
      ...momoHeaders(token), 'Content-Type': 'application/json', 'X-Reference-Id': txRef,
      ...(p.publicUrl && p.momo.callbackKey ? { 'X-Callback-Url': `${p.publicUrl}/webhooks/momo/${p.momo.callbackKey}` } : {})
    },
    body: JSON.stringify({
      amount: String(p.fee), currency: p.currency, externalId: txRef,
      payer: { partyIdType: 'MSISDN', partyId: payer.slice(1) },
      payerMessage: 'MamaSafe enrolment', payeeNote: 'MamaSafe enrolment'
    })
  });
  if (res.status !== 202) throw new Error('requesttopay ' + res.status);
}

// ---------- Airtel Money "USSD push" ----------
let airtelToken = { value: '', exp: 0 };
async function airtelAuth() {
  if (airtelToken.value && Date.now() < airtelToken.exp - 60000) return airtelToken.value;
  const a = config.payments.airtel;
  const res = await http(`${a.baseUrl}/auth/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: a.clientId, client_secret: a.clientSecret, grant_type: 'client_credentials' })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error('Airtel token failed: ' + res.status);
  airtelToken = { value: body.access_token, exp: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return airtelToken.value;
}
const airtelHeaders = (token) => ({
  Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: '*/*',
  'X-Country': config.payments.airtel.country, 'X-Currency': config.payments.currency
});

async function sendAirtel(txRef, payer) {
  const p = config.payments, a = p.airtel;
  const res = await http(`${a.baseUrl}/merchant/v2/payments/`, {
    method: 'POST', headers: airtelHeaders(await airtelAuth()),
    body: JSON.stringify({
      reference: 'MamaSafe enrolment',
      subscriber: { country: a.country, currency: p.currency, msisdn: payer.replace(/^\+256/, '') }, // national number, no country code
      transaction: { amount: p.fee, country: a.country, currency: p.currency, id: txRef }
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.status && body.status.success === false)) throw new Error('airtel payments ' + res.status);
}

async function verifyAirtel(db, order) {
  const res = await http(`${config.payments.airtel.baseUrl}/standard/v1/payments/${encodeURIComponent(order.tx_ref)}`, { headers: airtelHeaders(await airtelAuth()) });
  if (!res.ok) throw new Error('airtel status ' + res.status); // transient
  const t = ((await res.json().catch(() => ({}))).data || {}).transaction || {};
  if (t.id && t.id !== order.tx_ref) return { status: 'pending' };
  if (t.status === 'TS') { settle(db, order.tx_ref, t.airtel_money_id); return { status: 'successful' }; }
  if (t.status === 'TF') {
    db.prepare("UPDATE payments SET status = 'failed', note = ? WHERE tx_ref = ? AND status = 'pending'").run('Airtel: ' + String(t.message || 'failed').slice(0, 150), order.tx_ref);
    return { status: 'failed' };
  }
  return { status: 'pending' }; // TIP / TA / anything else: keep waiting
}

async function verifyMomo(db, order) {
  const m = config.payments.momo;
  const res = await http(`${m.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(order.tx_ref)}`, { headers: momoHeaders(await momoAuth()) });
  if (!res.ok) throw new Error('momo status ' + res.status); // transient: try again later
  const d = await res.json().catch(() => ({}));
  if (d.status === 'SUCCESSFUL') {
    const ok = Number(d.amount) >= order.amount && d.currency === order.currency && (!d.externalId || d.externalId === order.tx_ref);
    if (!ok) {
      db.prepare("UPDATE payments SET status = 'failed', note = ? WHERE tx_ref = ? AND status = 'pending'").run(`mismatch: got ${d.amount} ${d.currency}`, order.tx_ref);
      return { status: 'failed' };
    }
    settle(db, order.tx_ref, d.financialTransactionId);
    return { status: 'successful' };
  }
  if (d.status === 'FAILED') {
    db.prepare("UPDATE payments SET status = 'failed', note = ? WHERE tx_ref = ? AND status = 'pending'").run('MTN: ' + String(d.reason || 'failed').slice(0, 150), order.tx_ref);
    return { status: 'failed' };
  }
  return { status: 'pending' };
}

// Callback URL: /webhooks/momo/<MOMO_CALLBACK_KEY>. The key is the only secret; the body is never trusted.
async function momoCallback(db, key, body) {
  const want = config.payments.momo.callbackKey;
  if (!want) return { status: 503, text: 'Callback key not configured' };
  if (!safeEqual(key || '', want)) return { status: 401, text: 'Bad key' };
  const ref = body && (body.externalId || body.referenceId);
  if (!ref) return { status: 200, text: 'ignored' };
  try { await verify(db, String(ref)); } catch { return { status: 500, text: 'retry' }; }
  return { status: 200, text: 'OK' };
}

// Airtel posts { transaction: { id, status_code, ... } } to the URL configured in its portal:
// https://YOUR-DOMAIN/webhooks/airtel/<AIRTEL_CALLBACK_KEY>. Treated only as a hint, like MTN's.
async function airtelCallback(db, key, body) {
  const want = config.payments.airtel.callbackKey;
  if (!want) return { status: 503, text: 'Callback key not configured' };
  if (!safeEqual(key || '', want)) return { status: 401, text: 'Bad key' };
  const ref = body && body.transaction && body.transaction.id;
  if (!ref) return { status: 200, text: 'ignored' };
  try { await verify(db, String(ref)); } catch { return { status: 500, text: 'retry' }; }
  return { status: 200, text: 'OK' };
}

// Check the mother's open prompt (used while her browser or phone waits). Also settles mock prompts in development.
async function pollOpen(db, motherId) {
  const o = db.prepare("SELECT * FROM payments WHERE mother_id = ? AND status = 'pending' AND provider IN ('momo','airtel','mockmomo') ORDER BY id DESC LIMIT 1").get(motherId);
  if (!o) return null;
  if (o.provider === 'mockmomo') { settle(db, o.tx_ref, 'mock'); return { status: 'successful' }; }
  try { return await verify(db, o.tx_ref); } catch { return { status: 'pending' }; }
}

// Staff can waive the fee (sponsored mothers, clinic-paid, hardship). Never turn anyone away for money.
function waive(db, motherId, by, note) {
  db.prepare("INSERT INTO payments (tx_ref, mother_id, amount, currency, provider, status, note, created_at, paid_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(newRef(), motherId, 0, config.payments.currency, 'waiver', 'waived', `${by}${note ? ': ' + note : ''}`.slice(0, 200), now(), now());
}

// Development only: pretend the hosted page succeeded or failed.
function mockComplete(db, txRef, success) {
  if (config.env === 'production' || live()) return { status: 'unknown' };
  const o = db.prepare("SELECT 1 FROM payments WHERE tx_ref = ? AND provider = 'mock' AND status = 'pending'").get(txRef);
  if (!o) return { status: 'unknown' };
  if (success) settle(db, txRef, 'mock');
  else db.prepare("UPDATE payments SET status = 'failed' WHERE tx_ref = ?").run(txRef);
  return { status: success ? 'successful' : 'failed' };
}

const list = (db, limit = 200) => db.prepare(`SELECT p.*, m.phone AS mother_phone, m.name AS mother_name FROM payments p
  JOIN mothers m ON m.id = p.mother_id ORDER BY p.id DESC LIMIT ?`).all(limit);

const resetMomoToken = () => { momoToken = { value: '', exp: 0 }; airtelToken = { value: '', exp: 0 }; };

module.exports = { resetMomoToken, required, live, momoLive, canPush, momoPush, momoCallback, airtelCallback, airtelLive, pollOpen, summary, hasAccess, checkout, verify, webhook, waive, mockComplete, list, setFetch };

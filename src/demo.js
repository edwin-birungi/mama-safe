'use strict';
// Developer / demo access. A tester who cannot receive our SMS can sign in with a fixed access code, but ONLY
// with one of the reserved demo phone numbers. Everything a demo account does is sandboxed: no SMS is sent to
// or on behalf of a demo number, and no real facility, driver or contact is ever contacted.
// Never put a real person's number in DEMO_PHONES: the code would let anyone take that number over.
const crypto = require('crypto');
const config = require('./config');
const { normalizePhone } = require('./phone');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const MIN_CODE = 8;
const fails = new Map(); // phone -> { n, until }

function phones() {
  return String(config.demo.phones || '').split(/[,;\s]+/).map((p) => normalizePhone(p)).filter(Boolean);
}
const enabled = () => String(config.demo.code || '').length >= MIN_CODE && phones().length > 0;
const isDemoPhone = (phone) => enabled() && phones().includes(phone);

// { ok } or { error }. Ten wrong tries lock that number for 15 minutes.
function check(phone, code, now = Date.now()) {
  const f = fails.get(phone);
  if (f && f.until && now < f.until) return { error: 'Too many wrong tries. Wait 15 minutes.' };
  const a = Buffer.from(sha(String(code || '').trim())), b = Buffer.from(sha(String(config.demo.code)));
  if (crypto.timingSafeEqual(a, b)) { fails.delete(phone); return { ok: true }; }
  const n = ((f && !f.until) ? f.n : 0) + 1;
  fails.set(phone, n >= 10 ? { n, until: now + 15 * 60000 } : { n });
  return { error: 'Wrong demo access code.' };
}

module.exports = { enabled, isDemoPhone, check, phones, MIN_CODE, resetFails: () => fails.clear() };

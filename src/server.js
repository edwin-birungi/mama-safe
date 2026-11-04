'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const { open } = require('./db');
const { normalizePhone } = require('./phone');
const triage = require('./triage');
const schedule = require('./schedule');
const facilities = require('./facilities');
const mothersSvc = require('./mothers');
const alerts = require('./alerts');
const sms = require('./sms');
const messages = require('./messages');
const reminders = require('./reminders');
const auth = require('./auth');
const payments = require('./payments');
const ussd = require('./ussd');
const smsCommands = require('./smsCommands');
const { importCsv } = require('./importFacilities');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 65536) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType) {
  if (!raw) return {};
  if (String(contentType || '').includes('json')) {
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const validCoords = (lat, lng) =>
  lat === undefined || lng === undefined || (Math.abs(lat) <= 90 && Math.abs(lng) <= 180);

function createServer(db) {
  const hits = new Map(); // ip -> { count, reset } for a simple per-IP rate limit
  const limited = (key, max) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now > h.reset) { hits.set(key, { count: 1, reset: now + 60000 }); return false; }
    return ++h.count > max;
  };
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60000).unref();

  function adminCheck(req) {
    if (!config.dashboard.pass) {
      if (config.env === 'production') throw new HttpError(503, 'Set DASHBOARD_PASS to enable the dashboard.');
      return; // development: open, with a warning logged at startup
    }
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      if (auth.safeEqual(u, config.dashboard.user) && auth.safeEqual(rest.join(':'), config.dashboard.pass)) return;
    }
    const err = new HttpError(401, 'Authentication required');
    err.headers = { 'WWW-Authenticate': 'Basic realm="MamaSafe dashboard"' };
    throw err;
  }

  function webhookCheck(query) {
    if (config.webhookKey && !auth.safeEqual(query.get('key') || '', config.webhookKey)) throw new HttpError(403, 'Forbidden');
  }

  function motherAuth(req) {
    const h = req.headers.authorization || '';
    const phone = auth.phoneForToken(db, h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!phone) throw new HttpError(401, 'Please sign in again.');
    return { phone, mother: mothersSvc.byPhone(db, phone) };
  }

  function profile(mother) {
    const g = schedule.gestation(mother.lmp);
    return {
      registered: true,
      mother: { id: mother.id, name: mother.name, phone: mother.phone, lmp: mother.lmp, smsOptin: mother.sms_optin, contactPhone: mother.contact_phone, facilityId: mother.facility_id },
      gestation: g,
      edd: schedule.edd(mother.lmp),
      visits: schedule.visits(mother.lmp),
      next: schedule.nextVisit(mother.lmp),
      facility: mother.facility_id ? facilities.publicView(facilities.byId(db, mother.facility_id)) : null,
      payment: payments.summary(db, mother.id)
    };
  }

  // ---- routes: [method, path regex, handler] -> returns { status?, json?, text?, headers? }
  const routes = [];
  const route = (method, p, handler) => routes.push({ method, re: new RegExp('^' + p.replace(/:\w+/g, '([^/]+)') + '$'), handler });

  route('GET', '/healthz', () => ({ json: { ok: true } }));

  // Gateways
  route('POST', '/ussd', ({ body, query }) => {
    webhookCheck(query);
    return { text: ussd.handle(db, { phone: body.phoneNumber, text: body.text || '' }) };
  });
  route('POST', '/sms/inbound', ({ body, query }) => {
    webhookCheck(query);
    const from = body.from;
    const reply = smsCommands.handle(db, { from, text: body.text });
    const to = normalizePhone(from);
    if (reply && to) sms.send(db, to, reply, 'reply');
    return { text: 'OK' };
  });

  // Public API
  const helplines = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed', 'helplines.json'), 'utf8')); } catch { return { lines: [] }; }
  })();
  route('GET', '/api/config', () => ({
    json: {
      ussdCode: config.ussdCode, smsNumber: config.smsNumber, emergencyNumber: config.emergencyNumber, countryCode: config.countryCode,
      googleMapsKey: config.googleMapsKey, googleMapId: config.googleMapId, helplines: helplines.lines, helplinesChecked: helplines.researched_on
    }
  }));
  // Find facilities. lat/lng sorts nearest first; kind, open24 and q (name or district) filter;
  // limit/offset page. alert_phone and internal notes are never included.
  route('GET', '/api/facilities', ({ query }) => {
    const lat = num(query.get('lat')), lng = num(query.get('lng'));
    if (lat !== undefined && !Number.isFinite(lat) || lng !== undefined && !Number.isFinite(lng) || !validCoords(lat, lng)) throw new HttpError(400, 'Bad coordinates');
    const opts = {
      lat, lng, kind: query.get('kind') || undefined, q: query.get('q') || undefined, open24: query.get('open24') === '1'
    };
    const limit = Math.min(Math.max(Number(query.get('limit')) || 200, 1), 500);
    const offset = Math.max(Number(query.get('offset')) || 0, 0);
    const all = facilities.list(db, opts);
    return { json: { total: all.length, facilities: all.slice(offset, offset + limit).map(facilities.publicView) } };
  });
  route('GET', '/api/symptoms', () => ({ json: { symptoms: triage.visibleSymptoms() } }));
  route('POST', '/api/triage', ({ body }) => {
    const ids = Array.isArray(body.symptoms) ? body.symptoms.filter((s) => typeof s === 'string').slice(0, 20) : [];
    const r = triage.classify(ids);
    return { json: { ...r, labels: triage.labelsFor(r.matched) } };
  });

  // Payments (optional). The browser is sent to Flutterwave's hosted page; we confirm with them directly.
  route('POST', '/api/payments/checkout', async ({ req, body, ip }) => {
    const { mother } = motherAuth(req);
    if (!mother) throw new HttpError(404, 'Register first.');
    if (limited('pay:' + ip, 10)) throw new HttpError(429, 'Slow down.');
    try {
      const r = await payments.checkout(db, mother, { email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email || '') ? body.email : undefined });
      return { json: { link: r.link, mock: !!r.mock } };
    } catch (e) { throw e.status ? new HttpError(e.status, e.message) : e; }
  });
  // Send a payment prompt to the mother's MTN MoMo phone; she approves it with her PIN.
  route('POST', '/api/payments/momo', async ({ req, body, ip }) => {
    const { mother } = motherAuth(req);
    if (!mother) throw new HttpError(404, 'Register first.');
    if (limited('momo:' + ip, 10)) throw new HttpError(429, 'Slow down.');
    try {
      const r = await payments.momoPush(db, mother, body.phone || undefined);
      return { json: { ok: true, payer: r.payer } };
    } catch (e) { throw e.status ? new HttpError(e.status, e.message) : e; }
  });
  // The page polls this while she approves on her phone; it asks MTN if a prompt is open.
  route('GET', '/api/payments/status', async ({ req }) => {
    const { mother } = motherAuth(req);
    if (!mother) throw new HttpError(404, 'Register first.');
    const polled = await payments.pollOpen(db, mother.id);
    return { json: { ...payments.summary(db, mother.id), last: polled && polled.status } };
  });
  for (const method of ['PUT', 'POST']) {
    route(method, '/webhooks/airtel/:key', async ({ params, body }) => {
      const r = await payments.airtelCallback(db, params[0], body);
      return { status: r.status, text: r.text };
    });
    route(method, '/webhooks/momo/:key', async ({ params, body }) => {
      const r = await payments.momoCallback(db, params[0], body);
      return { status: r.status, text: r.text };
    });
  }
  route('POST', '/webhooks/flutterwave', async ({ req, body }) => {
    const r = await payments.webhook(db, req.headers, body);
    return { status: r.status, text: r.text };
  });
  // Where Flutterwave sends the mother's browser afterwards. The URL's "status" is NOT trusted.
  route('GET', '/pay/return', async ({ query }) => {
    const ref = query.get('tx_ref') || '';
    let st = 'pending';
    try { st = (await payments.verify(db, ref)).status; } catch { /* webhook will settle it */ }
    return { redirect: '/?payment=' + (st === 'successful' ? 'success' : st === 'failed' ? 'failed' : 'pending') };
  });
  route('GET', '/pay/mock', ({ query }) => {
    if (config.env === 'production' || payments.live()) throw new HttpError(404, 'Not found');
    const r = payments.mockComplete(db, query.get('tx_ref') || '', query.get('result') !== 'fail');
    return { redirect: '/?payment=' + (r.status === 'successful' ? 'success' : 'failed') };
  });

  // Phone sign-in
  route('POST', '/api/otp/request', ({ body, ip }) => {
    if (limited('otp:' + ip, 10)) throw new HttpError(429, 'Slow down and try again soon.');
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, 'Enter a valid phone number.');
    const r = auth.requestOtp(db, phone);
    if (r.error) throw new HttpError(429, r.error);
    // Development convenience only: never returned in production.
    return { json: { ok: true, phone, ...(config.env !== 'production' ? { devCode: r.code } : {}) } };
  });
  route('POST', '/api/otp/verify', ({ body, ip }) => {
    if (limited('verify:' + ip, 20)) throw new HttpError(429, 'Slow down and try again soon.');
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, 'Enter a valid phone number.');
    const r = auth.verifyOtp(db, phone, body.code);
    if (r.error) throw new HttpError(400, r.error);
    const m = mothersSvc.byPhone(db, phone);
    return { json: { token: r.token, registered: !!m } };
  });

  // Signed-in mother
  route('GET', '/api/me', ({ req }) => {
    const { phone, mother } = motherAuth(req);
    return { json: mother ? profile(mother) : { registered: false, phone } };
  });
  route('POST', '/api/register', ({ req, body }) => {
    const { phone, mother } = motherAuth(req);
    if (mother) throw new HttpError(409, 'Already registered.');
    const lmp = String(body.lmp || '');
    if (!schedule.validateLmp(schedule.parseDate(lmp), schedule.localToday())) {
      throw new HttpError(400, 'The last period date must be within the last 40 weeks and not in the future.');
    }
    const facilityId = body.facilityId ? Number(body.facilityId) : null;
    if (facilityId && !facilities.byId(db, facilityId)) throw new HttpError(400, 'Unknown facility.');
    let contactPhone = null;
    if (body.contactPhone) {
      contactPhone = normalizePhone(body.contactPhone);
      if (!contactPhone) throw new HttpError(400, 'Emergency contact number is not valid.');
    }
    const m = mothersSvc.create(db, {
      phone, name: String(body.name || '').trim().slice(0, 40) || null, lmp, facilityId, contactPhone,
      smsOptin: body.smsOptin !== false, channel: 'app'
    });
    sms.send(db, phone, messages.welcome(db, m), 'welcome');
    return { status: 201, json: profile(m) };
  });
  route('PATCH', '/api/me', ({ req, body }) => {
    const { mother } = motherAuth(req);
    if (!mother) throw new HttpError(404, 'Not registered.');
    const f = {};
    if (body.name !== undefined) f.name = String(body.name).trim().slice(0, 40) || null;
    if (body.smsOptin !== undefined) f.smsOptin = !!body.smsOptin;
    if (body.facilityId !== undefined) {
      if (body.facilityId && !facilities.byId(db, Number(body.facilityId))) throw new HttpError(400, 'Unknown facility.');
      f.facilityId = body.facilityId ? Number(body.facilityId) : null;
    }
    if (body.contactPhone !== undefined) {
      f.contactPhone = body.contactPhone ? normalizePhone(body.contactPhone) : null;
      if (body.contactPhone && !f.contactPhone) throw new HttpError(400, 'Emergency contact number is not valid.');
    }
    return { json: profile(mothersSvc.update(db, mother.id, f)) };
  });
  route('POST', '/api/alerts', ({ req, body, ip }) => {
    const { mother } = motherAuth(req);
    if (!mother) throw new HttpError(404, 'Register first.');
    if (limited('alert:' + ip, 10)) throw new HttpError(429, 'Slow down.');
    const ids = Array.isArray(body.symptoms) && body.symptoms.length ? body.symptoms : ['sos'];
    const result = triage.classify(ids);
    if (result.level !== 'emergency') throw new HttpError(400, 'These symptoms are not an emergency.');
    const lat = num(body.lat), lng = num(body.lng);
    if (!validCoords(lat, lng)) throw new HttpError(400, 'Bad coordinates');
    const r = alerts.createAlert(db, { mother, symptoms: result.matched, lat, lng, channel: 'app' });
    return { status: 201, json: { alertId: r.alert.id, duplicate: r.duplicate, notified: r.notified, facility: r.facility && facilities.publicView(r.facility) } };
  });

  // Dashboard API (HTTP Basic auth)
  route('GET', '/api/admin/alerts', ({ req, query }) => {
    adminCheck(req);
    const status = query.get('status') || undefined;
    const facilityId = query.get('facility') ? Number(query.get('facility')) : undefined;
    return { json: { alerts: alerts.listForDashboard(db, { status, facilityId }), facilities: facilities.list(db).map((f) => ({ id: f.id, name: f.name })) } };
  });
  route('POST', '/api/admin/alerts/:id/ack', ({ req, params }) => {
    adminCheck(req);
    const ok = alerts.acknowledge(db, Number(params[0]), 'dashboard');
    return { status: ok ? 200 : 404, json: { ok } };
  });
  // Staff-maintained contact details. alert_phone must be a MOBILE that can receive SMS.
  route('PATCH', '/api/admin/facilities/:id', ({ req, params, body }) => {
    adminCheck(req);
    const f = facilities.byId(db, Number(params[0]));
    if (!f) throw new HttpError(404, 'Unknown facility.');
    const sets = [], vals = [];
    for (const k of ['phone', 'emergency_phone', 'toll_free', 'alert_phone']) {
      if (body[k] === undefined) continue;
      const v = body[k] ? normalizePhone(body[k]) : null;
      if (body[k] && !v) throw new HttpError(400, `${k} is not a valid number.`);
      sets.push(`${k} = ?`); vals.push(v);
    }
    if (body.open24 !== undefined) { sets.push('open24 = ?'); vals.push(body.open24 === null ? null : body.open24 ? 1 : 0); }
    if (sets.length) {
      sets.push('contact_confidence = ?', 'researched_on = ?');
      vals.push('medium', new Date().toISOString().slice(0, 10));
      db.prepare(`UPDATE facilities SET ${sets.join(', ')} WHERE id = ?`).run(...vals, f.id);
    }
    return { json: { facility: facilities.byId(db, f.id) } };
  });
  route('POST', '/api/admin/mothers/:id/waive', ({ req, params, body }) => {
    adminCheck(req);
    const m = mothersSvc.byId(db, Number(params[0]));
    if (!m) throw new HttpError(404, 'Unknown mother.');
    payments.waive(db, m.id, 'dashboard', String(body.note || ''));
    return { json: payments.summary(db, m.id) };
  });
  route('GET', '/api/admin/payments', ({ req }) => {
    adminCheck(req);
    return { json: { payments: payments.list(db) } };
  });
  route('GET', '/api/admin/outbox', ({ req }) => {
    adminCheck(req);
    return { json: { sms: { live: sms.configured() }, messages: db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 100').all() } };
  });

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname === '/dashboard' ? '/dashboard.html' : pathname;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
    if (path.basename(file).startsWith('dashboard')) adminCheck(req);
    const ext = path.extname(file);
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream' };
    if (ext === '.html' || path.basename(file) === 'sw.js') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const secure = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' https://unpkg.com" + (config.googleMapsKey ? ' https://maps.googleapis.com' : '') + '; ' +
        "style-src 'self' 'unsafe-inline' https://unpkg.com" + (config.googleMapsKey ? ' https://fonts.googleapis.com' : '') + '; ' +
        "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com" + (config.googleMapsKey ? ' https://maps.gstatic.com https://maps.googleapis.com https://*.ggpht.com https://*.googleusercontent.com' : '') + '; ' +
        "font-src 'self' https://fonts.gstatic.com; " +
        "connect-src 'self'" + (config.googleMapsKey ? ' https://maps.googleapis.com https://*.googleapis.com' : '') + "; worker-src 'self' blob:; frame-ancestors 'none'"
    };
    for (const [k, v] of Object.entries(secure)) res.setHeader(k, v);
    try {
      const trust = process.env.TRUST_PROXY === 'true';
      const ip = (trust && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if ((pathname.startsWith('/api/') || pathname === '/ussd' || pathname === '/sms/inbound') && limited('api:' + ip, 240)) {
        throw new HttpError(429, 'Too many requests');
      }
      const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method);
      const body = hasBody ? parseBody(await readBody(req), req.headers['content-type']) : {};
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const out = (await r.handler({ req, body, query: url.searchParams, params: m.slice(1), ip })) || {};
        if (out.redirect) { res.writeHead(302, { Location: out.redirect, 'Cache-Control': 'no-store' }); return res.end(); }
        if (out.text !== undefined) {
          res.writeHead(out.status || 200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(out.text);
        }
        res.writeHead(out.status || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(out.json || {}));
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(e.headers || {}) });
      res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong.' : e.message }));
    }
  });
}

// First run: load the curated Uganda list (real hospitals, contact details flagged by confidence).
function seedFacilities(db) {
  if (facilities.count(db) > 0) return;
  const r = importCsv(db, path.join(__dirname, '..', 'seed', 'facilities.uganda.csv'));
  console.warn(`Loaded ${r.imported} hospitals from seed/facilities.uganda.csv. Add health centres and clinics with: npm run import:facilities`);
  console.warn('Phone numbers have contact_confidence flags. Confirm them by phone, and set alert_phone (a mobile) per facility so alerts can be sent by SMS.');
}

function main() {
  const db = open(config.dbPath);
  seedFacilities(db);
  if (!config.dashboard.pass) {
    console.warn(config.env === 'production'
      ? 'WARNING: DASHBOARD_PASS is not set; the dashboard is disabled.'
      : 'DEVELOPMENT: dashboard is open (no DASHBOARD_PASS set).');
  }
  if (!sms.configured()) console.warn('SMS is in DRY-RUN mode: messages are recorded but not sent. Set AT_USERNAME and AT_API_KEY to send.');
  const server = createServer(db);
  server.listen(config.port, () => console.log(`MamaSafe listening on http://localhost:${config.port}`));
  const tick = () => { try { const n = reminders.run(db); if (n) console.log(`Queued ${n} visit reminder(s).`); } catch (e) { console.error('reminders failed', e); } };
  setTimeout(tick, 10000).unref();
  setInterval(tick, 30 * 60000).unref();
  setInterval(() => sms.retryPending(db).catch(() => {}), 5 * 60000).unref();
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main();

module.exports = { createServer, seedFacilities };

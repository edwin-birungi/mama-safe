'use strict';
const config = require('./config');
const demo = require('./demo');

const configured = () => !!(config.at.username && config.at.apiKey);

// Deliveries in progress, so a caller (such as the sign-in code route) can wait for the result.
const inflight = new Map();
const settled = (id) => inflight.get(id) || Promise.resolve();

// Queue a message. It is always written to the outbox first (so nothing is lost and the dashboard
// can show it). If Africa's Talking credentials are set it is then sent in the background;
// otherwise it stays in "dry-run" status.
function send(db, to, body, kind = 'general') {
  const now = new Date().toISOString();
  const status = demo.isDemoPhone(to) ? 'demo' : configured() ? 'queued' : 'dry-run';
  const { lastInsertRowid } = db
    .prepare('INSERT INTO outbox (to_phone, body, kind, status, created_at) VALUES (?,?,?,?,?)')
    .run(to, body, kind, status, now);
  const id = Number(lastInsertRowid);
  if (status === 'queued') {
    const p = deliver(db, id).catch(() => {}).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return id;
}

async function deliver(db, id) {
  const msg = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
  if (!msg || msg.status === 'sent') return;
  const host = config.at.sandbox ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
  const form = new URLSearchParams({ username: config.at.username, to: msg.to_phone, message: msg.body });
  if (config.at.senderId) form.set('from', config.at.senderId);
  try {
    const res = await fetch(`https://${host}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: config.at.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15000)
    });
    // Africa's Talking answers some errors (for example a wrong key) with plain text, not JSON: keep that text.
    const text = await res.text().catch(() => '');
    let json = {};
    try { json = JSON.parse(text); } catch { /* plain text */ }
    const rec = json && json.SMSMessageData && json.SMSMessageData.Recipients && json.SMSMessageData.Recipients[0];
    const ok = res.ok && rec && /success/i.test(rec.status);
    db.prepare('UPDATE outbox SET status = ?, error = ?, sent_at = ? WHERE id = ?').run(
      ok ? 'sent' : 'failed',
      ok ? null : `HTTP ${res.status}: ${rec ? JSON.stringify(rec) : text}`.slice(0, 300),
      new Date().toISOString(),
      id
    );
    // Do not keep one-time codes lying around once they have been delivered.
    if (ok && msg.kind === 'otp') db.prepare("UPDATE outbox SET body = '[one-time code removed]' WHERE id = ?").run(id);
  } catch (e) {
    db.prepare('UPDATE outbox SET status = ?, error = ? WHERE id = ?').run('failed', String(e.message).slice(0, 300), id);
  }
}

// Retry anything that failed or was left queued (called periodically by the server).
async function retryPending(db) {
  if (!configured()) return;
  // Never re-send an old one-time code: it has expired, and a late code only confuses people.
  const rows = db.prepare("SELECT id FROM outbox WHERE status IN ('queued','failed') AND kind != 'otp' AND created_at > ? ORDER BY id LIMIT 50")
    .all(new Date(Date.now() - 24 * 3600000).toISOString());
  for (const r of rows) await deliver(db, r.id);
}

module.exports = { send, deliver, retryPending, configured, settled };

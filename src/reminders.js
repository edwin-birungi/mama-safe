'use strict';
const config = require('./config');
const schedule = require('./schedule');
const facilities = require('./facilities');
const sms = require('./sms');
const payments = require('./payments');

const KINDS = { 7: 'd7', 3: 'd3', 1: 'd1', 0: 'd0' };

function text(kind, mother, visit, facility) {
  const hello = mother.name ? `Hello ${mother.name}. ` : '';
  const when = { d7: 'is in 1 week', d3: 'is in 3 days', d1: 'is TOMORROW', d0: 'is TODAY' }[kind];
  const at = facility ? ` at ${facility.name}` : '';
  return `MamaSafe: ${hello}Your antenatal visit ${visit.no} of 8 ${when} (${schedule.pretty(visit.date)})${at}. Please bring your antenatal card.`;
}

// Sends due reminders (1 week, 3 days, 1 day before, and on the day) once each, within the daytime
// window. Safe to call as often as you like.
function run(db, now = new Date()) {
  const hour = schedule.localHour(now);
  if (hour < config.reminderFromHour || hour > config.reminderToHour) return 0;
  const today = schedule.localToday(now);
  let sent = 0;
  for (const m of db.prepare('SELECT * FROM mothers WHERE sms_optin = 1').all()) {
    const next = schedule.nextVisit(m.lmp, today);
    if (!next) continue;
    if (!payments.hasAccess(db, m.id)) continue; // fee on and unpaid: reminders wait. Emergency help never does.
    const diff = Math.round((schedule.parseDate(next.date) - today) / 86400000);
    const kind = KINDS[diff];
    if (!kind) continue;
    const ins = db
      .prepare('INSERT OR IGNORE INTO reminders_sent (mother_id, visit_no, kind, sent_at) VALUES (?,?,?,?)')
      .run(m.id, next.no, kind, now.toISOString());
    if (ins.changes === 0) continue;
    const facility = m.facility_id ? facilities.byId(db, m.facility_id) : null;
    sms.send(db, m.phone, text(kind, m, next, facility), 'reminder');
    sent++;
  }
  return sent;
}

module.exports = { run, text };

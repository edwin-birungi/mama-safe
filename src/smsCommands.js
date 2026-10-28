'use strict';
// Inbound SMS keywords. Returns the reply text, or null when nothing more needs sending
// (for example SOS, where the alert itself already sends the confirmations).

const config = require('./config');
const triage = require('./triage');
const schedule = require('./schedule');
const facilities = require('./facilities');
const mothersSvc = require('./mothers');
const alerts = require('./alerts');
const sms = require('./sms');
const messages = require('./messages');
const { normalizePhone } = require('./phone');

const MENU_IDS = triage.visibleSymptoms().map((s) => s.id);

function symptomMenu() {
  const parts = triage.visibleSymptoms().map((s, i) => `${i + 1} ${s.short}`);
  return 'MamaSafe: reply SYMPTOM and the numbers that apply, e.g. SYMPTOM 1 9. ' + parts.join(', ') + '.';
}

function handle(db, { from, text }) {
  const phone = normalizePhone(from);
  if (!phone) return null;
  const words = String(text || '').trim().replace(/\s+/g, ' ').split(' ');
  const cmd = (words[0] || '').toUpperCase();
  const args = words.slice(1);

  // A facility acknowledging an alert: "ACK 12" from the facility's registered phone.
  if (cmd === 'ACK') {
    const fac = db.prepare('SELECT * FROM facilities WHERE phone = ?').get(phone);
    if (!fac) return null;
    const id = Number(args[0]);
    const ok = Number.isInteger(id) && alerts.acknowledge(db, id, `sms:${phone}`);
    return ok ? `MamaSafe: alert #${id} acknowledged. Thank you.` : `MamaSafe: no open alert #${args[0] || ''}.`;
  }

  const mother = mothersSvc.byPhone(db, phone);

  if (cmd === 'REG') {
    if (mother) return 'MamaSafe: you are already registered. Text HELP for options.';
    const lmp = schedule.parseDdmmyy(args[0] || '');
    const fac = args[1] ? facilities.byCode(db, args[1]) : null;
    if (!lmp) return 'MamaSafe: date not understood. Text REG DDMMYY CODE, e.g. REG 120426 SHC4 (first day of your last period).';
    if (!fac) {
      const codes = facilities.list(db).slice(0, 6).map((f) => `${f.code}=${f.name}`).join(', ');
      return `MamaSafe: clinic code not found. Text REG ${args[0]} CODE. Codes: ${codes}. Ask a health worker for yours.`;
    }
    const name = args.slice(2).join(' ').slice(0, 30) || null;
    const m = mothersSvc.create(db, { phone, name, lmp, facilityId: fac.id, channel: 'sms' });
    return messages.welcome(db, m);
  }

  if (cmd === 'SYMPTOM' || cmd === 'SYMPTOMS') {
    const ids = args.map((a) => MENU_IDS[Number(a) - 1]).filter(Boolean);
    if (!ids.length) return symptomMenu();
    const result = triage.classify(ids);
    if (result.level === 'emergency') {
      if (mother) {
        alerts.createAlert(db, { mother, symptoms: result.matched, channel: 'sms' });
        return null;
      }
      return `MamaSafe: GO TO A HEALTH FACILITY NOW. Call ${config.emergencyNumber} if worse. Register with REG so we can alert your clinic.`;
    }
    return `MamaSafe: ${result.advice}`;
  }

  if (cmd === 'SOS' && !mother) {
    return `MamaSafe: GO TO A HEALTH FACILITY NOW. Call ${config.emergencyNumber} if you cannot get there. Register with REG so we can alert your clinic next time.`;
  }

  if (cmd === 'HELP' || cmd === '' || !mother) {
    return mother ? messages.HELP_REGISTERED : messages.HELP_UNREGISTERED;
  }

  switch (cmd) {
    case 'SOS':
      alerts.createAlert(db, { mother, symptoms: ['sos'], channel: 'sms' });
      return null;
    case 'VISIT': {
      const next = schedule.nextVisit(mother.lmp);
      const fac = mother.facility_id ? facilities.byId(db, mother.facility_id) : null;
      return next
        ? `MamaSafe: visit ${next.no} of 8 is ${schedule.pretty(next.date)}${fac ? ' at ' + fac.name : ''}.`
        : 'MamaSafe: no more visits planned. Text SOS if you need urgent help.';
    }
    case 'CLINIC': {
      const fac = mother.facility_id ? facilities.byId(db, mother.facility_id) : null;
      return fac ? `MamaSafe: your clinic is ${fac.name}, ${fac.area}${fac.phone ? '. Tel ' + fac.phone : ''}.` : 'MamaSafe: no clinic saved yet.';
    }
    case 'STOP':
      mothersSvc.update(db, mother.id, { smsOptin: false });
      return 'MamaSafe: you will no longer get visit reminders. Text START to get them again. SOS still works.';
    case 'START':
      mothersSvc.update(db, mother.id, { smsOptin: true });
      return 'MamaSafe: visit reminders are on again.';
    default:
      return messages.HELP_REGISTERED;
  }
}

module.exports = { handle, symptomMenu };

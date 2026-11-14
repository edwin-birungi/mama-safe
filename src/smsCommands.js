'use strict';
// Inbound SMS keywords. Returns the reply text, or null when nothing more needs sending
// (for example SOS, where the alert itself already sends the confirmations).

const config = require('./config');
const triage = require('./triage');
const schedule = require('./schedule');
const facilities = require('./facilities');
const mothersSvc = require('./mothers');
const alerts = require('./alerts');
const transport = require('./transport');
const contact = require('./contact');
const payments = require('./payments');
const sms = require('./sms');
const messages = require('./messages');
const { normalizePhone, local } = require('./phone');

const MENU_IDS = triage.visibleSymptoms().map((s) => s.id);

function symptomMenu() {
  const parts = triage.visibleSymptoms().map((s, i) => `${i + 1} ${s.short}`);
  return 'MamaSafe: reply SYMPTOM and the numbers that apply, e.g. SYMPTOM 1 9. ' + parts.join(', ') + '.';
}

// "Name, District. Tel 0414554001. Toll-free 0800100036." Only numbers we actually hold.
function clinicLine(f) {
  const bits = [`${f.name}, ${f.area}`];
  if (f.phone) bits.push(`Tel ${local(f.phone)}`);
  if (f.emergency_phone) bits.push(`Emergency ${local(f.emergency_phone)}`);
  if (f.toll_free) bits.push(`Toll-free ${local(f.toll_free)}`);
  return bits.join('. ') + '.';
}

function clinics(db, query) {
  const q = String(query).trim();
  if (!q) return 'MamaSafe: text CLINICS and your district or town, e.g. CLINICS Gulu.';
  const found = facilities.list(db, { q, limit: 3 });
  if (!found.length) return `MamaSafe: no listed facility for "${q.slice(0, 30)}". Try your district name. Call ${config.emergencyNumber} in an emergency.`;
  return 'MamaSafe: ' + found.map((f) => `${f.code}=${f.name}${f.phone || f.emergency_phone || f.toll_free ? ' ' + local(f.phone || f.emergency_phone || f.toll_free) : ''}`).join('; ') + '. Register with REG DDMMYY CODE.';
}

function handle(db, { from, text }) {
  const phone = normalizePhone(from);
  if (!phone) return null;
  const words = String(text || '').trim().replace(/\s+/g, ' ').split(' ');
  const cmd = (words[0] || '').toUpperCase();
  const args = words.slice(1);

  // A facility acknowledging an alert: "ACK 12" from the facility's registered phone.
  if (cmd === 'ACK') {
    // Only a facility's registered alert mobile may acknowledge; a landline or random number cannot.
    const fac = db.prepare('SELECT id FROM facilities WHERE alert_phone = ?').get(phone);
    if (!fac) return null;
    const id = Number(args[0]);
    const ok = Number.isInteger(id) && alerts.acknowledge(db, id, `sms:${phone}`);
    return ok ? `MamaSafe: alert #${id} acknowledged. Thank you.` : `MamaSafe: no open alert #${args[0] || ''}.`;
  }

  // A driver answering a pickup request ("GO 12") or switching availability (BUSY / AVAILABLE).
  if (cmd === 'GO' || cmd === 'BUSY' || cmd === 'AVAILABLE') {
    const provider = transport.byPhone(db, phone);
    if (provider) return transport.handleSms(db, provider, cmd, args);
  }

  const mother = mothersSvc.byPhone(db, phone);

  if (cmd === 'REG') {
    if (mother) return 'MamaSafe: you are already registered. Text HELP for options.';
    const lmp = schedule.parseDdmmyy(args[0] || '');
    const fac = args[1] ? facilities.byCodeOrId(db, args[1]) : null;
    if (!lmp) return 'MamaSafe: date not understood. Text REG DDMMYY CODE, e.g. REG 120426 MULAGO (first day of your last period; find codes with CLINICS DISTRICT).';
    if (!fac) {
      return `MamaSafe: clinic code not found. Text CLINICS and your district (e.g. CLINICS Gulu) to get codes, then REG ${args[0]} CODE.`;
    }
    const name = args.slice(2).join(' ').slice(0, 30) || null;
    const m = mothersSvc.create(db, { phone, name, lmp, facilityId: fac.id, channel: 'sms' });
    return messages.welcome(db, m);
  }

  // Find places to get care: "CLINICS Gulu". Works for anyone, registered or not.
  if (cmd === 'CLINICS' || cmd === 'HOSPITAL' || cmd === 'HOSPITALS') return clinics(db, args.join(' '));

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
      return fac ? `MamaSafe: ${clinicLine(fac)}` : 'MamaSafe: no clinic saved yet. Text CLINICS and your district to find one.';
    }
    case 'PAY': {
      // "PAY" sends a mobile-money prompt (MTN or Airtel) to this phone; "PAY 0772123456" sends it to another number.
      const c = payments.canPush(db, mother, args[0]);
      if (c.error) return `MamaSafe: ${c.error}`;
      payments.momoPush(db, mother, args[0]).catch(() =>
        sms.send(db, phone, 'MamaSafe: we could not send the payment prompt. Please text PAY to try again.', 'payment'));
      return `MamaSafe: a payment prompt is coming to ${local(c.payer)}. Enter your mobile money PIN to pay ${config.payments.currency} ${config.payments.fee.toLocaleString('en-US')}. Emergency help is always free.`;
    }
    case 'CONTACT': {
      // "CONTACT 0772123456" saves a new emergency contact; "CONTACT" alone re-sends the code. The code goes to THEM.
      let m = mother;
      if (args[0]) {
        const c = normalizePhone(args[0]);
        if (!c) return 'MamaSafe: that number is not valid. Text CONTACT 0772123456.';
        if (c === mother.phone) return 'MamaSafe: your emergency contact must be someone else.';
        m = mothersSvc.update(db, mother.id, { contactPhone: c });
      }
      if (!m.contact_phone) return 'MamaSafe: no emergency contact saved. Text CONTACT and their number, e.g. CONTACT 0772123456.';
      const r = contact.requestCode(db, m);
      return r.error ? `MamaSafe: ${r.error}` : `MamaSafe: we texted a code to ${local(m.contact_phone)}. Ask them for it, then text CONFIRM and the code, e.g. CONFIRM 123456.`;
    }
    case 'CONFIRM': {
      const r = contact.verifyCode(db, mother, args[0] || '');
      return r.error ? `MamaSafe: ${r.error}` : 'MamaSafe: your emergency contact is confirmed. They will be told if you send SOS.';
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

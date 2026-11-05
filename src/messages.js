'use strict';
const schedule = require('./schedule');
const facilities = require('./facilities');
const payments = require('./payments');
const config = require('./config');

// SMS sent after a mother registers on any channel.
function welcome(db, mother) {
  const g = schedule.gestation(mother.lmp);
  const next = schedule.nextVisit(mother.lmp);
  const fac = mother.facility_id ? facilities.byId(db, mother.facility_id) : null;
  return `MamaSafe: Welcome${mother.name ? ' ' + mother.name : ''}. You are in week ${g.weeks}, due about ${schedule.pretty(schedule.edd(mother.lmp))}. ` +
    (next ? `Next visit ${next.no} of 8: ${schedule.pretty(next.date)}${fac ? ' at ' + fac.name : ''}. We will remind you. ` : '') +
    'Text HELP for options.' +
    (payments.required() && !payments.hasAccess(db, mother.id)
      ? ` To start visit reminders, pay ${config.payments.currency} ${config.payments.fee.toLocaleString('en-US')}: text PAY to this number (MTN or Airtel Money prompt), or use card at ${config.payments.publicUrl || 'the MamaSafe app'}. Emergency help is always free.`
      : '');
}

const HELP_REGISTERED =
  'MamaSafe: VISIT = next visit, CLINIC = your clinic, CLINICS DISTRICT = find one, SYMPTOM = check how you feel, SOS = emergency alert, STOP/START = reminders on/off.';
const HELP_UNREGISTERED =
  'MamaSafe: To register text REG DDMMYY CODE (first day of last period, then your clinic code). Find your code: CLINICS DISTRICT. Example: REG 120426 MULAGO. SYMPTOM = check danger signs.';

module.exports = { welcome, HELP_REGISTERED, HELP_UNREGISTERED };

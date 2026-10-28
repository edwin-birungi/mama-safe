'use strict';
// USSD menu for Africa's Talking style gateways.
//
// The gateway sends `text` = every answer so far joined by "*" ("" on the first request, "2*1" after
// two answers). We keep NO session state: each request replays the answers through a small state
// machine. Side effects (registering, raising an alert) only happen in the final, terminal step,
// which is the last request of the session, so replaying never repeats them.
//
// Each screen must stay under ~182 characters (USSD limit); the tests check this.

const config = require('./config');
const triage = require('./triage');
const schedule = require('./schedule');
const facilities = require('./facilities');
const mothersSvc = require('./mothers');
const alerts = require('./alerts');
const sms = require('./sms');
const messages = require('./messages');
const { normalizePhone } = require('./phone');

const PAGE1 = ['bleeding', 'fits', 'headache', 'movement'];
const PAGE2 = ['belly', 'fluid', 'fever', 'breath', 'swelling', 'vomiting', 'mild'];
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '.' : s);
const num = (s) => (/^\d{1,2}$/.test(s) ? Number(s) : NaN);
const label = (id) => triage.BY_ID[id].ussd;

// Pure transition: (state, answer) -> new state. Sets `action` when the session should end.
function step(st, input, env) {
  const go = (screen, data) => ({ screen, data: { ...st.data, ...data }, err: null });
  const bad = () => ({ ...st, err: 'Invalid choice.' });
  const n = num(input);

  switch (st.screen) {
    case 'main':
      if (env.registered) {
        return { 1: go('visit'), 2: go('unwell1'), 3: go('clinic'), 4: go('sos') }[n] || bad();
      }
      return { 1: go('reg_lmp'), 2: go('unwell1') }[n] || bad();
    case 'visit':
    case 'clinic':
      return input === '0' ? go('main') : bad();
    case 'unwell1':
      if (input === '0') return go('main');
      if (n === 5) return go('unwell2');
      if (n >= 1 && n <= PAGE1.length) return { ...st, err: null, action: { type: 'triage', symptom: PAGE1[n - 1] } };
      return bad();
    case 'unwell2':
      if (input === '0') return go('unwell1');
      if (n >= 1 && n <= PAGE2.length) return { ...st, err: null, action: { type: 'triage', symptom: PAGE2[n - 1] } };
      return bad();
    case 'sos':
      if (n === 1) return { ...st, err: null, action: { type: 'sos' } };
      if (n === 2) return go('main');
      return bad();
    case 'reg_lmp': {
      if (input === '0') return go('main');
      const lmp = schedule.parseDdmmyy(input);
      if (!lmp) return { ...st, err: 'Invalid date. Use DDMMYY.' };
      return env.areas.length ? go('reg_area', { lmp }) : go('reg_contact', { lmp });
    }
    case 'reg_area':
      if (input === '0') return go('reg_lmp');
      if (n >= 1 && n <= env.areas.length) return go('reg_facility', { area: env.areas[n - 1] });
      return bad();
    case 'reg_facility': {
      if (input === '0') return go('reg_area');
      const list = env.inArea(st.data.area);
      if (n >= 1 && n <= list.length) return go('reg_contact', { facilityId: list[n - 1].id });
      return bad();
    }
    case 'reg_contact': {
      if (input === '0') return go(env.areas.length ? 'reg_facility' : 'reg_lmp');
      if (input === '1') return { ...st, err: null, action: { type: 'register', contact: null } };
      const contact = normalizePhone(input);
      if (!contact) return { ...st, err: 'Invalid number.' };
      return { ...st, err: null, action: { type: 'register', contact } };
    }
    default:
      return bad();
  }
}

function render(st, env, mother, db) {
  const e = st.err ? st.err + '\n' : '';
  const fac = mother && mother.facility_id ? facilities.byId(db, mother.facility_id) : null;
  switch (st.screen) {
    case 'main':
      return env.registered
        ? 'MamaSafe\n1. My next visit\n2. I feel unwell\n3. My health facility\n4. EMERGENCY'
        : e + 'Welcome to MamaSafe\n1. Register\n2. Check danger signs';
    case 'visit': {
      const next = schedule.nextVisit(mother.lmp);
      return next
        ? `Visit ${next.no} of 8\n${schedule.pretty(next.date)}${fac ? '\n' + cut(fac.name, 40) : ''}\nWe will SMS you reminders.\n0. Back`
        : `No more visits planned.\nDue about ${schedule.pretty(schedule.edd(mother.lmp))}.\n0. Back`;
    }
    case 'clinic':
      return fac
        ? `Your facility:\n${cut(fac.name, 40)}\n${fac.area}${fac.phone ? '\nTel ' + fac.phone : ''}\n0. Back`
        : 'No facility saved.\n0. Back';
    case 'unwell1':
      return e + 'Do you have:\n' + PAGE1.map((id, i) => `${i + 1}. ${label(id)}`).join('\n') + '\n5. More signs\n0. Back';
    case 'unwell2':
      return e + 'Do you have:\n' + PAGE2.map((id, i) => `${i + 1}. ${label(id)}`).join('\n') + '\n0. Back';
    case 'sos':
      return e + 'Send an EMERGENCY alert to your health facility and contact?\n1. Yes, send\n2. No, go back';
    case 'reg_lmp':
      return e + 'Register\nFirst day of your last period as DDMMYY (example 120426)\n0. Back';
    case 'reg_area':
      return e + 'Your area:\n' + env.areas.map((a, i) => `${i + 1}. ${cut(a, 22)}`).join('\n') + '\n0. Back';
    case 'reg_facility':
      return e + 'Your clinic:\n' + env.inArea(st.data.area).map((f, i) => `${i + 1}. ${cut(f.name, 26)}`).join('\n') + '\n0. Back';
    case 'reg_contact':
      return e + 'Phone number of someone we can alert in an emergency\n1. Skip\n0. Back';
    default:
      return 'MamaSafe';
  }
}

function runAction(db, action, st, env, mother, phone) {
  if (action.type === 'triage') {
    const result = triage.classify([action.symptom]);
    const fac = mother && mother.facility_id ? facilities.byId(db, mother.facility_id) : null;
    if (result.level === 'emergency') {
      if (mother) {
        const r = alerts.createAlert(db, { mother, symptoms: [action.symptom], channel: 'ussd' });
        return `GO TO A HEALTH FACILITY NOW.\n${r.facility ? cut(r.facility.name, 40) + ' has been alerted.' : ''}\nCall ${config.emergencyNumber} if worse.`;
      }
      return `GO TO A HEALTH FACILITY NOW.\nCall ${config.emergencyNumber} if worse.\nRegister on MamaSafe so we can alert your clinic.`;
    }
    if (result.level === 'urgent') {
      return `See a midwife or doctor TODAY${fac ? ' at ' + cut(fac.name, 36) : ''}.\nDo not wait for your next visit.`;
    }
    return `Common in pregnancy. Tell the midwife at your next visit. Dial ${config.ussdCode} again if you get worse.`;
  }
  if (action.type === 'sos') {
    const r = alerts.createAlert(db, { mother, symptoms: ['sos'], channel: 'ussd' });
    return `ALERT SENT.\n${r.facility ? cut(r.facility.name, 40) + ' and your' : 'Your'} contact have been told.\nGo to the facility now if you can. Call ${config.emergencyNumber} if worse.`;
  }
  if (action.type === 'register') {
    const existing = mothersSvc.byPhone(db, phone);
    if (existing) return 'You are already registered. Dial again to use the menu.';
    const m = mothersSvc.create(db, {
      phone, lmp: st.data.lmp, facilityId: st.data.facilityId, contactPhone: action.contact, channel: 'ussd'
    });
    sms.send(db, phone, messages.welcome(db, m), 'welcome');
    const g = schedule.gestation(m.lmp);
    const next = schedule.nextVisit(m.lmp);
    return `Registered.\nWeek ${g.weeks}, due about ${schedule.pretty(schedule.edd(m.lmp))}.\n${next ? 'Next visit: ' + schedule.pretty(next.date) + '.\n' : ''}We will SMS you reminders.`;
  }
  return 'MamaSafe';
}

// Returns the gateway response string: "CON ..." keeps the session open, "END ..." closes it.
function handle(db, { phone, text }) {
  const p = normalizePhone(phone);
  if (!p) return 'END Sorry, we could not read your phone number.';
  const mother = mothersSvc.byPhone(db, p);
  const areaList = facilities.areas(db).slice(0, 8);
  const env = {
    registered: !!mother,
    areas: areaList,
    inArea: (a) => facilities.inArea(db, a).slice(0, 8)
  };
  const answers = text ? String(text).split('*') : [];
  let st = { screen: 'main', data: {}, err: null };
  for (const a of answers) {
    st = step(st, a.trim(), env);
    if (st.action) break;
  }
  if (st.action) return 'END ' + runAction(db, st.action, st, env, mother, p);
  return 'CON ' + render(st, env, mother, db);
}

module.exports = { handle, step, render, PAGE1, PAGE2 };

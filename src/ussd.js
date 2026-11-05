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
const payments = require('./payments');
const sms = require('./sms');
const messages = require('./messages');
const { normalizePhone, local } = require('./phone');

const PAGE1 = ['bleeding', 'fits', 'headache', 'movement'];
const PAGE2 = ['belly', 'fluid', 'fever', 'breath', 'swelling', 'vomiting', 'mild'];
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '.' : s);
const PAGE_SIZE = 4;
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
        return { 1: go('visit'), 2: go('unwell1'), 3: go('clinic'), 4: go('sos'), 5: go('area_q', { purpose: 'find' }), ...(env.payDue ? { 6: go('pay') } : {}) }[n] || bad();
      }
      return { 1: go('reg_lmp'), 2: go('unwell1'), 3: go('area_q', { purpose: 'find' }) }[n] || bad();
    case 'visit':
    case 'clinic':
    case 'fac_detail':
      if (input === '0') return st.screen === 'fac_detail' ? go('fac_list') : go('main');
      return bad();
    case 'pay':
      if (input === '0') return go('main');
      if (n === 1) return { ...st, err: null, action: { type: 'pay', payer: null } };
      if (n === 2) return go('pay_other');
      return bad();
    case 'pay_other': {
      if (input === '0') return go('pay');
      const payer = normalizePhone(input);
      if (!payer) return { ...st, err: 'Invalid number.' };
      return { ...st, err: null, action: { type: 'pay', payer } };
    }
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
      return env.hasFacilities ? go('area_q', { lmp, purpose: 'reg' }) : go('reg_contact', { lmp });
    }
    // Pick a district by typing its first letters: there are far too many to list on a phone screen.
    case 'area_q': {
      if (input === '0') return go(st.data.purpose === 'reg' ? 'reg_lmp' : 'main');
      if (input.length < 2) return { ...st, err: 'Type at least 2 letters.' };
      const found = env.searchAreas(input);
      if (!found.length) return { ...st, err: 'No district found.' };
      return found.length === 1 ? go('fac_list', { q: input, area: found[0], page: 0 }) : go('area_pick', { q: input });
    }
    case 'area_pick': {
      if (input === '0') return go('area_q');
      const found = env.searchAreas(st.data.q);
      if (n >= 1 && n <= found.length) return go('fac_list', { area: found[n - 1], page: 0 });
      return bad();
    }
    case 'fac_list': {
      const list = env.inArea(st.data.area);
      const page = st.data.page || 0;
      if (input === '0') return go(env.searchAreas(st.data.q || '').length > 1 ? 'area_pick' : 'area_q');
      if (n === 9 && (page + 1) * PAGE_SIZE < list.length) return go('fac_list', { page: page + 1 });
      const item = list[page * PAGE_SIZE + n - 1];
      if (n >= 1 && n <= PAGE_SIZE && item) {
        return st.data.purpose === 'reg' ? go('reg_contact', { facilityId: item.id }) : go('fac_detail', { facilityId: item.id });
      }
      return bad();
    }
    case 'reg_contact': {
      if (input === '0') return env.hasFacilities ? go('fac_list') : go('reg_lmp');
      if (input === '1') return { ...st, err: null, action: { type: 'register', contact: null } };
      const contact = normalizePhone(input);
      if (!contact) return { ...st, err: 'Invalid number.' };
      return { ...st, err: null, action: { type: 'register', contact } };
    }
    default:
      return bad();
  }
}

// Name, district and every number we hold. Never invents one.
function facilityScreen(f, title) {
  if (!f) return 'Not found.\n0. Back';
  const nums = [];
  if (f.phone) nums.push('Tel ' + local(f.phone));
  if (f.emergency_phone) nums.push('Emergency ' + local(f.emergency_phone));
  if (f.toll_free) nums.push('Toll-free ' + local(f.toll_free));
  return `${title}:\n${cut(f.name, 40)}\n${cut(f.area, 20)}\n` +
    (nums.length ? nums.join('\n') : `No number on file. Call ${config.emergencyNumber} in an emergency.`) + '\n0. Back';
}

function render(st, env, mother, db) {
  const e = st.err ? st.err + '\n' : '';
  const fac = mother && mother.facility_id ? facilities.byId(db, mother.facility_id) : null;
  switch (st.screen) {
    case 'main':
      return env.registered
        ? 'MamaSafe\n1. My next visit\n2. I feel unwell\n3. My health facility\n4. EMERGENCY\n5. Find a hospital' + (env.payDue ? '\n6. Pay fee' : '')
        : e + 'Welcome to MamaSafe\n1. Register\n2. Check danger signs\n3. Find a hospital';
    case 'visit': {
      const next = schedule.nextVisit(mother.lmp);
      return next
        ? `Visit ${next.no} of 8\n${schedule.pretty(next.date)}${fac ? '\n' + cut(fac.name, 40) : ''}\nWe will SMS you reminders.\n0. Back`
        : `No more visits planned.\nDue about ${schedule.pretty(schedule.edd(mother.lmp))}.\n0. Back`;
    }
    case 'clinic':
      return fac ? facilityScreen(fac, 'Your facility') : 'No facility saved.\n0. Back';
    case 'fac_detail':
      return facilityScreen(facilities.byId(db, st.data.facilityId), 'Facility');
    case 'pay':
      return e + `Pay ${config.payments.currency} ${config.payments.fee.toLocaleString('en-US')} to start reminders. A prompt comes to your MTN or Airtel Money phone: enter your PIN.\n1. Pay with this number\n2. Another number\n0. Back`;
    case 'pay_other':
      return e + 'Type the MTN or Airtel Money number to charge, e.g. 0772123456\n0. Back';
    case 'unwell1':
      return e + 'Do you have:\n' + PAGE1.map((id, i) => `${i + 1}. ${label(id)}`).join('\n') + '\n5. More signs\n0. Back';
    case 'unwell2':
      return e + 'Do you have:\n' + PAGE2.map((id, i) => `${i + 1}. ${label(id)}`).join('\n') + '\n0. Back';
    case 'sos':
      return e + 'Send an EMERGENCY alert to your health facility and contact?\n1. Yes, send\n2. No, go back';
    case 'reg_lmp':
      return e + 'Register\nFirst day of your last period as DDMMYY (example 120426)\n0. Back';
    case 'area_q':
      return e + (st.data.purpose === 'reg' ? 'Your clinic: type your district (first letters)\n0. Back' : 'Find a hospital: type your district (first letters)\n0. Back');
    case 'area_pick':
      return e + 'Which district?\n' + env.searchAreas(st.data.q).map((a, i) => `${i + 1}. ${cut(a, 22)}`).join('\n') + '\n0. Back';
    case 'fac_list': {
      const list = env.inArea(st.data.area), page = st.data.page || 0;
      const rows = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((f, i) => `${i + 1}. ${cut(f.name, 26)}`);
      return e + `${cut(st.data.area, 20)}:\n` + (rows.join('\n') || 'None listed') + ((page + 1) * PAGE_SIZE < list.length ? '\n9. More' : '') + '\n0. Back';
    }
    case 'reg_contact':
      return e + 'Phone number of someone we can alert in an emergency\n1. Skip\n0. Back';
    default:
      return 'MamaSafe';
  }
}

// Say exactly what happened: a facility is only "told" if an SMS really went to it.
function alertResult(r, head) {
  const f = r.facility;
  const tel = f && facilities.bestPhone(f);
  const lines = [head];
  if (f && r.notified) lines.push(`${cut(f.name, 40)} has been told.`);
  else if (f) lines.push(`Go to ${cut(f.name, 36)}.${tel ? ' Tel ' + local(tel) + '.' : ''} We could not message them.`);
  lines.push(`Call ${config.emergencyNumber} if worse.`);
  return lines.join('\n');
}

function runAction(db, action, st, env, mother, phone) {
  if (action.type === 'pay') {
    const c = payments.canPush(db, mother, action.payer);
    if (c.error) return c.error;
    // Answer at once; the prompt reaches her phone a moment later. If the operator refuses, we tell her by SMS.
    payments.momoPush(db, mother, action.payer).catch(() =>
      sms.send(db, phone, 'MamaSafe: we could not send the payment prompt. Dial again and choose Pay fee to retry.', 'payment'));
    return `A payment prompt is coming to ${local(c.payer)}.\nEnter your mobile money PIN to approve. We will SMS you when it is done.`;
  }
  if (action.type === 'triage') {
    const result = triage.classify([action.symptom]);
    const fac = mother && mother.facility_id ? facilities.byId(db, mother.facility_id) : null;
    if (result.level === 'emergency') {
      if (mother) {
        const r = alerts.createAlert(db, { mother, symptoms: [action.symptom], channel: 'ussd' });
        return alertResult(r, 'GO TO A HEALTH FACILITY NOW.');
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
    return alertResult(r, 'ALERT SENT.');
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
  const env = {
    registered: !!mother,
    payDue: !!mother && payments.required() && !payments.hasAccess(db, mother.id),
    hasFacilities: facilities.count(db) > 0,
    searchAreas: (q) => facilities.searchAreas(db, q, 6),
    inArea: (a) => facilities.inArea(db, a)
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

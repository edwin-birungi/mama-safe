(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } }
  };

  const main = $('#main'), nav = $('#nav'), notice = $('#notice');
  let cfg = { ussdCode: '', smsNumber: '', emergencyNumber: '999', helplines: [] };
  let token = store.get('ms_token');
  let me = null;
  let pos = null;
  let mapHandle = null;
  let care = { q: '', kind: '', open24: false, limit: 20 };
  let view = 'home';
  let backView = 'home';

  const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
  const ICON = {
    heart: '<path d="M12 21s-7.5-4.8-7.5-10.6A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 2.8C19.5 16.2 12 21 12 21z" fill="currentColor" stroke="none"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    pulse: '<path d="M12 20.5s-7-4.5-7-10a4.1 4.1 0 0 1 7-2.8 4.1 4.1 0 0 1 7 2.8c0 5.5-7 10-7 10z"/><path d="M7.5 12h2.2l1.3-2.5 2 4.5 1.3-2h2.2"/>',
    pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
    alert: '<path d="M12 3.5 2.8 19.5h18.4L12 3.5z"/><path d="M12 10v4.2M12 17h.01"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    chat: '<path d="M4 5.5h16v10.5H9.5L5.5 20v-4H4z"/><path d="M8 9.5h8M8 12.5h5"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.5c.8-4 3.6-5.8 7.2-5.8s6.4 1.8 7.2 5.8"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6L12 3z"/><path d="m8.8 12 2.4 2.4 4.2-4.6"/>',
    book: '<path d="M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5v13c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5z"/><path d="M12 6v13.5"/>',
    install: '<path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
    question: '<circle cx="12" cy="12" r="9.5"/><path d="M9.5 9.3a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1.9-1.1 1.7M12 17h.01"/>'
  };
  let auth = { step: 'phone', phone: '' };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || 'Something went wrong.');
      e.status = res.status;
      throw e;
    }
    return data;
  }

  // ---------- phone + link helpers ----------
  const telHref = (p) => 'tel:' + String(p).replace(/[^+\d]/g, '');
  // +256414554001 -> 0414 554 001 (Ugandan numbers); anything else is shown as given.
  function fmtPhone(p) {
    const m = /^\+256(\d{3})(\d{3})(\d{3})$/.exec(p || '');
    return m ? `0${m[1]} ${m[2]} ${m[3]}` : String(p || '');
  }
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  function dirUrl(f) {
    return f.lat != null && f.lng != null
      ? `https://www.google.com/maps/dir/?api=1&destination=${f.lat},${f.lng}&travelmode=driving`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${f.name}, ${f.area}, Uganda`)}`;
  }
  const KIND = { hospital: 'Hospital', health_centre: 'Health centre', clinic: 'Clinic', other: 'Facility' };
  const bestPhone = (f) => f && (f.phone || f.emergency_phone || f.toll_free);

  // Every number we hold, each one a tap-to-call button. Nothing is invented: no number, no button.
  function contactHtml(f) {
    const b = [];
    if (f.phone) b.push(`<a class="btn" href="${telHref(f.phone)}">Call ${esc(fmtPhone(f.phone))}</a>`);
    if (f.emergency_phone) b.push(`<a class="btn emerg" href="${telHref(f.emergency_phone)}">Emergency ${esc(fmtPhone(f.emergency_phone))}</a>`);
    if (f.toll_free) b.push(`<a class="btn tf" href="${telHref(f.toll_free)}">Toll-free ${esc(fmtPhone(f.toll_free))}</a>`);
    let html = b.length ? `<div class="row">${b.join('')}</div>` : `<p class="muted warn">No phone number on file for this facility. In an emergency call ${esc(cfg.emergencyNumber)}.</p>`;
    if (b.length && f.contact_confidence === 'low') html += '<p class="muted warn">This number comes from an older or unofficial source and may have changed.</p>';
    return html;
  }

  function say(msg, isError) {
    notice.hidden = !msg;
    notice.textContent = msg || '';
    notice.className = isError ? 'error' : '';
  }

  function locate(timeout = 6000) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout, maximumAge: 60000 }
      );
    });
  }

  const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const isoToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

  function show(html) {
    if (mapHandle) { mapHandle.destroy(); mapHandle = null; }
    main.innerHTML = html;
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function setNav() {
    nav.hidden = !(me && me.registered);
    nav.querySelectorAll('button').forEach((b) => {
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  function signOut() {
    token = null; me = null; auth = { step: 'phone', phone: '' };
    store.del('ms_token');
    go('auth');
  }

  async function go(v) {
    view = v;
    say('');
    setNav();
    try {
      if (v === 'auth') return renderAuth();
      if (v === 'tour') return renderTour(0);
      if (v === 'guide') return renderGuide();
      if (v === 'register') return await renderRegister();
      if (v === 'home') return renderHome();
      if (v === 'visits') return renderVisits();
      if (v === 'sos') return renderSos();
      if (v === 'check') return await renderCheck();
      if (v === 'care') return await renderCare();
    } catch (e) {
      if (e.status === 401) return signOut();
      say(e.message, true);
    }
  }

  // ---------- sign in ----------
  function renderAuth() {
    nav.hidden = true;
    if (auth.step === 'phone') {
      show(`<div class="welcome"><div class="mark">${svg(ICON.heart)}</div>
        <h1>Welcome to MamaSafe</h1>
        <p class="muted" style="font-size:16px;margin:0">Visit reminders, a danger-sign check and one-tap emergency alerts, all in your pocket.</p></div>
        <form id="f" class="card" style="margin-top:20px"><label for="phone" style="margin-top:0">Your phone number</label>
        <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0712 345 678" required>
        <p class="muted" style="margin:8px 0 0">We will text you a 6-digit code. Your number is only used for reminders and emergency alerts.</p>
        <button class="full" type="submit">Send me a code</button></form>
        <button class="ghost full" id="findcare" type="button">Find a hospital near me</button>
        <button class="link full" id="howto" type="button" style="margin-top:6px">First time here? Read the quick guide</button>
        ${basicPhoneCard()}
        <div class="trust"><span>Free emergency help</span><span>No card needed to sign in</span><span>Works on any phone</span></div>`);
      $('#findcare').onclick = () => go('care');
      $('#howto').onclick = () => openGuide();
      $('#f').onsubmit = async (e) => {
        e.preventDefault();
        const btn = $('#f button'); btn.disabled = true;
        try {
          const r = await api('/api/otp/request', { method: 'POST', body: { phone: $('#phone').value } });
          auth = { step: 'code', phone: r.phone, devCode: r.devCode };
          renderAuth();
        } catch (err) { say(err.message, true); btn.disabled = false; }
      };
    } else {
      show(`<h1>Enter your code</h1>
        <p class="muted">We sent a 6-digit code by SMS to ${esc(auth.phone)}.</p>
        ${auth.devCode ? `<p class="muted"><b>Development mode:</b> your code is ${esc(auth.devCode)}.</p>` : ''}
        <form id="f"><label for="code">6-digit code</label>
        <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
        <button class="full" type="submit">Continue</button>
        <button class="full ghost" type="button" id="back">Use a different number</button></form>`);
      $('#back').onclick = () => { auth = { step: 'phone', phone: '' }; renderAuth(); };
      $('#f').onsubmit = async (e) => {
        e.preventDefault();
        const btn = $('#f button'); btn.disabled = true;
        try {
          const r = await api('/api/otp/verify', { method: 'POST', body: { phone: auth.phone, code: $('#code').value } });
          token = r.token; store.set('ms_token', token);
          await loadMe();
          go(me.registered ? 'home' : 'register');
        } catch (err) { say(err.message, true); btn.disabled = false; }
      };
    }
  }

  function basicPhoneCard() {
    if (!cfg.ussdCode) return '';
    return `<div class="card"><b>No smartphone or no data?</b><p class="muted" style="margin:6px 0 0">Dial <b>${esc(cfg.ussdCode)}</b> on any phone${cfg.smsNumber ? `, or text <b>HELP</b> to <b>${esc(cfg.smsNumber)}</b>` : ''}.</p></div>`;
  }

  async function loadMe() { me = await api('/api/me'); }

  // ---------- register ----------
  async function renderRegister() {
    nav.hidden = true;
    let chosen = null;
    show(`<h1>Tell us about your pregnancy</h1>
      <p class="muted">This sets up your visit schedule and your clinic.</p>
      <form id="f">
        <label for="name">Your first name</label>
        <input id="name" type="text" autocomplete="given-name" maxlength="40">
        <label for="lmp">First day of your last period</label>
        <input id="lmp" type="date" min="${isoDaysAgo(280)}" max="${isoToday()}" required>
        <label for="fsearch">Your clinic or hospital</label>
        <input id="fsearch" type="search" placeholder="Type a district or the clinic's name" autocomplete="off">
        <button class="ghost" type="button" id="loc" style="margin-top:10px">${pos ? 'Showing the nearest to you' : 'Use my location'}</button>
        <div id="fres" class="pick" role="radiogroup" aria-label="Choose your facility"></div>
        <label for="contact">Phone of someone we can alert in an emergency</label>
        <input id="contact" type="tel" inputmode="tel" autocomplete="off" placeholder="Husband, mother, friend (optional)">
        <label class="check"><input id="sms" type="checkbox" checked> Send visit reminders by SMS</label>
        <button class="full" type="submit">Create my profile</button>
      </form>`);
    const list = async () => {
      const box = $('#fsearch');
      if (!box) return; // the form was submitted while a search was pending
      const qs = new URLSearchParams({ limit: '8' });
      if (box.value.trim()) qs.set('q', box.value.trim());
      if (pos) { qs.set('lat', pos.lat); qs.set('lng', pos.lng); }
      try {
        const { facilities, total } = await api('/api/facilities?' + qs);
        if (!$('#fres') || box.value.trim() !== (qs.get('q') || '')) return; // stale answer
        $('#fres').innerHTML = facilities.map((f) => `<label class="check pickrow"><input type="radio" name="fac" value="${f.id}" ${chosen === f.id ? 'checked' : ''}>
          <span><b>${esc(f.name)}</b><br><span class="muted">${esc(KIND[f.kind] || '')} · ${esc(f.area)}${f.distanceKm != null ? ' · ' + f.distanceKm + ' km' : ''}</span></span></label>`).join('')
          + (total > facilities.length ? `<p class="muted">${total - facilities.length} more. Type to narrow the list.</p>` : '') || '<p class="muted">Nothing found. Try the district name.</p>';
      } catch (err) { say(err.message, true); }
    };
    let timer = null;
    $('#fsearch').oninput = () => { clearTimeout(timer); timer = setTimeout(list, 250); };
    $('#fres').onchange = (e) => { chosen = Number(e.target.value); };
    $('#loc').onclick = async () => { say('Finding your location…'); pos = await locate(); say(pos ? '' : 'Could not get your location. Search by district instead.', !pos); if (pos) { $('#loc').textContent = 'Showing the nearest to you'; list(); } };
    list();
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#f button[type=submit]'); btn.disabled = true;
      try {
        me = await api('/api/register', { method: 'POST', body: { name: $('#name').value, lmp: $('#lmp').value, facilityId: chosen, contactPhone: $('#contact').value, smsOptin: $('#sms').checked } });
        go(store.get('ms_tour_done') ? 'home' : 'tour');
      } catch (err) { say(err.message, true); btn.disabled = false; }
    };
  }

  // ---------- payment (only shown when the service charges an enrolment fee) ----------
  const money = (n, c) => `${c} ${Number(n).toLocaleString('en-US')}`;
  function payCard() {
    const p = me && me.payment;
    if (!p || !p.required) return '';
    if (p.paid) return `<div class="card"><b>&#10003; ${p.waived ? 'Your fee was covered.' : 'Payment received. Thank you.'}</b><div class="muted">Your visit reminders are on.</div></div>`;
    return `<div class="card pay"><b>Start your visit reminders</b>
      <p class="muted" style="margin:6px 0">One-time fee: <b>${esc(money(p.amount, p.currency))}</b>. We never see your card number or mobile money PIN.</p>
      <p class="muted" style="margin:0 0 6px"><b>Emergency alerts, the danger-sign check and finding a hospital are always free.</b></p>
      ${p.momo ? `<label for="momophone">Mobile money number (${esc((p.networks && p.networks.length ? p.networks : ['MTN', 'Airtel']).join(' or '))})</label>
        <input id="momophone" type="tel" inputmode="tel" value="${esc(me.mother.phone.replace(/^\+256/, '0'))}" autocomplete="off">
        <button class="full" id="paymomo" type="button">Pay ${esc(money(p.amount, p.currency))} by mobile money</button>
        <p class="muted" id="momohint" style="margin:6px 0 0">A prompt will appear on that phone. Enter your mobile money PIN to approve.</p>` : ''}
      ${p.hosted ? `<button class="full ghost" id="pay" type="button">Pay by card or other mobile money</button>` : ''}</div>`;
  }
  function wirePay() {
    const hosted = $('#pay');
    if (hosted) hosted.onclick = async () => {
      hosted.disabled = true; say('Opening the secure payment page…');
      try { const r = await api('/api/payments/checkout', { method: 'POST', body: {} }); location.href = r.link; }
      catch (err) { say(err.message, true); hosted.disabled = false; }
    };
    const momo = $('#paymomo');
    if (momo) momo.onclick = async () => {
      momo.disabled = true; say('');
      try {
        const r = await api('/api/payments/momo', { method: 'POST', body: { phone: $('#momophone').value } });
        $('#momohint').textContent = `Check the phone ${r.payer.replace(/^\+256/, '0')} and enter your mobile money PIN. Waiting for confirmation…`;
        waitForPayment(momo);
      } catch (err) { say(err.message, true); momo.disabled = false; }
    };
  }
  // Ask the server every few seconds whether she has approved (the server asks MTN). Gives up politely after 3 minutes.
  async function waitForPayment(btn) {
    const until = Date.now() + 180000;
    while (Date.now() < until && view === 'home') {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const st = await api('/api/payments/status');
        if (st.paid) { await loadMe(); go('home'); say('Payment received. Thank you!'); return; }
        if (st.last === 'failed') { say('The payment was not approved. You were not charged. Please try again.', true); btn.disabled = false; return; }
      } catch (e) { if (e.status === 401) return signOut(); }
    }
    if (view === 'home') { say('We have not received your approval yet. If you entered your PIN, you will get an SMS when it is confirmed.'); btn.disabled = false; }
  }

  // ---------- home ----------
  function renderHome() {
    const g = me.gestation, pct = Math.min(100, Math.round((g.totalDays / 280) * 100));
    const next = me.next;
    const tri = g.weeks < 13 ? 'FIRST TRIMESTER' : g.weeks < 28 ? 'SECOND TRIMESTER' : 'THIRD TRIMESTER';
    const left = Math.max(0, 40 - g.weeks);
    show(`<div class="hero"><div class="sub">Hello${me.mother.name ? ', ' + esc(me.mother.name) : ''}</div>
      <div class="big">Week ${g.weeks}</div>
      <div class="bar" role="img" aria-label="${pct} percent of pregnancy"><span style="width:${pct}%"></span></div>
      <div class="sub">Due about ${fmtDate(me.edd)}${left ? ' · ' + left + (left === 1 ? ' week' : ' weeks') + ' to go' : ''}</div>
      <span class="tri">${tri}</span></div>
      <div class="card">${next
        ? `<div class="muted"><b>NEXT VISIT · ${next.no} OF 8</b></div><div style="font-size:20px;font-weight:800">${fmtDate(next.date)}</div><div class="muted">${me.facility ? esc(me.facility.name) : 'No facility chosen yet'}</div>${me.facility && bestPhone(me.facility) ? `<a class="btn ghost" style="margin-top:8px" href="${telHref(bestPhone(me.facility))}">Call ${esc(fmtPhone(bestPhone(me.facility)))}</a>` : ''}`
        : '<b>No more visits planned.</b> Your baby is due soon. Text or tap SOS if you need urgent help.'}</div>
      <div class="danger-note"><b>Know the danger signs.</b> Heavy bleeding, fits, severe headache with blurred vision, or baby moving much less: go to a health facility straight away and press SOS.</div>
      <div class="quick">
        <button type="button" data-go="check"><span class="ico">${svg(ICON.pulse)}</span>Check my symptoms<small>Not feeling right?</small></button>
        <button type="button" data-go="care"><span class="ico">${svg(ICON.pin)}</span>Find a hospital<small>Nearest, with phone numbers</small></button>
        <button type="button" data-go="visits"><span class="ico">${svg(ICON.calendar)}</span>My 8 visits<small>Dates and reminders</small></button>
        <button type="button" data-go="guide"><span class="ico">${svg(ICON.book)}</span>User guide<small>How MamaSafe works</small></button>
      </div>
      ${payCard()}
      ${basicPhoneCard()}
      <h2>Settings</h2>
      <div class="card"><label class="check"><input id="optin" type="checkbox" ${me.mother.smsOptin ? 'checked' : ''}> SMS visit reminders</label>
      <button class="ghost full" id="out" type="button">Sign out</button></div>`);
    wirePay();
    document.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => (b.dataset.go === 'guide' ? openGuide() : go(b.dataset.go)); });
    $('#optin').onchange = async (e) => {
      try { me = await api('/api/me', { method: 'PATCH', body: { smsOptin: e.target.checked } }); say('Saved.'); } catch (err) { say(err.message, true); }
    };
    $('#out').onclick = signOut;
  }

  // ---------- visits ----------
  function renderVisits() {
    show(`<h1>My visits</h1><p class="muted">8 antenatal contacts, planned from your due date. Dates already passed are shown faded.</p>
      ${me.visits.map((v) => `<div class="card visit ${v.status}"><div class="dot">${v.no}</div><div><b>Visit ${v.no} · week ${v.week}</b><div class="muted">${fmtDate(v.date)}${v.status === 'next' ? ' · NEXT' : ''}</div>${v.status === 'next' && me.facility ? `<div class="muted">${esc(me.facility.name)}</div>` : ''}</div></div>`).join('')}
      <p class="muted">Bring your antenatal card to every visit.</p>`);
  }

  // ---------- symptom check ----------
  async function renderCheck() {
    const { symptoms } = await api('/api/symptoms');
    const groups = [['emergency', 'Danger signs'], ['urgent', 'Needs a check-up soon'], ['mild', 'Common and usually mild']];
    show(`<h1>How are you feeling?</h1><p class="muted">Tick everything that applies. This is a guide, not a diagnosis.</p>
      <form id="f">${groups.map(([lvl, title]) => `<div class="sympgroup"><h2><span class="pill ${lvl}">${lvl.toUpperCase()}</span> ${title}</h2>` +
        symptoms.filter((s) => s.level === lvl).map((s) => `<label class="check"><input type="checkbox" name="s" value="${esc(s.id)}"> ${esc(s.label)}</label>`).join('') + '</div>').join('')}
        <button class="full" type="submit">Check</button></form><div id="res" aria-live="polite"></div>`);
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const ids = [...document.querySelectorAll('input[name=s]:checked')].map((i) => i.value);
      const r = await api('/api/triage', { method: 'POST', body: { symptoms: ids } });
      const titles = { emergency: 'Go to a health facility now', urgent: 'Get checked today', mild: 'Mention it at your next visit', none: 'Nothing selected' };
      $('#res').innerHTML = `<div class="result ${r.level}"><h2>${titles[r.level]}</h2><p style="margin:0">${esc(r.advice)}</p>
        ${r.level === 'emergency' ? `<button class="full danger" style="background:#fff;color:#8e1b1b" id="alert" type="button">Alert my facility now</button>
        <a class="btn full ghost" style="border-color:#fff;color:#fff" href="tel:${esc(cfg.emergencyNumber)}">Call ${esc(cfg.emergencyNumber)}</a>` : ''}</div>`;
      const a = $('#alert');
      if (a) a.onclick = () => sendAlert(r.matched);
      $('#res').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
  }

  async function sendAlert(symptoms) {
    say('Sending your alert…');
    const where = await locate(4000);
    try {
      const r = await api('/api/alerts', { method: 'POST', body: { symptoms, ...(where || {}) } });
      say('');
      showAlertSent(r);
    } catch (err) {
      say('');
      showSosFallback(err.status ? err.message : 'No internet connection.');
    }
  }

  // ---------- SOS ----------
  function renderSos() {
    show(`<div class="sosview"><h1>Emergency help</h1>
      <p class="muted">Use this if you or your baby are in danger, for example heavy bleeding, fits, or severe pain.</p>
      <button class="sosbtn danger" id="sos" type="button">Send emergency alert</button>
      <div class="card"><b>One tap will</b><div class="muted" style="color:var(--muted)">Tell your health facility, with your location if your phone shares it. Tell your emergency contact. Text you a confirmation.</div></div>
      <a class="btn full" style="background:#fff;color:#8e1b1b" href="tel:${esc(cfg.emergencyNumber)}">Or call ${esc(cfg.emergencyNumber)} now</a></div>`);
    $('#sos').onclick = () => sendAlert(['sos']);
  }

  function showAlertSent(r) {
    const f = r.facility;
    const call = bestPhone(f);
    const told = r.notified
      ? `<div class="card"><b>${esc(f.name)} has been told.</b></div>`
      : `<div class="card"><b>${f ? 'Go to ' + esc(f.name) + '.' : 'Go to the nearest health facility.'}</b><div class="muted">We could not text them, so please call${call ? '' : ' ' + esc(cfg.emergencyNumber)}.</div></div>`;
    const contact = me && me.mother && me.mother.contactPhone ? '<div class="card"><b>Your emergency contact has been told.</b></div>' : '';
    show(`<div class="sosview"><h1>${r.notified ? 'Alert sent' : 'Please call now'}</h1><p class="muted">Go to the facility now if you can. Keep your phone with you.</p>
      ${told}${contact}
      ${f && f.emergency_phone ? `<a class="btn full" style="background:#fff;color:#8e1b1b" href="${telHref(f.emergency_phone)}">Call emergency line ${esc(fmtPhone(f.emergency_phone))}</a>` : ''}
      ${call ? `<a class="btn full" style="background:#fff;color:#8e1b1b" href="${telHref(call)}">Call the facility ${esc(fmtPhone(call))}</a>` : ''}
      ${f && f.toll_free ? `<a class="btn full ghost" style="border-color:#fff;color:#fff" href="${telHref(f.toll_free)}">Toll-free ${esc(fmtPhone(f.toll_free))}</a>` : ''}
      ${f ? `<a class="btn full ghost" style="border-color:#fff;color:#fff" target="_blank" rel="noopener" href="${esc(dirUrl(f))}">Directions</a>` : ''}
      <a class="btn full ghost" style="border-color:#fff;color:#fff" href="tel:${esc(cfg.emergencyNumber)}">Call ${esc(cfg.emergencyNumber)}</a></div>`);
  }

  // If the app cannot reach the server, SMS and calls still work without data.
  function showSosFallback(reason) {
    show(`<div class="sosview"><h1>Could not send the alert</h1><p class="muted">${esc(reason)} Use one of these instead:</p>
      ${cfg.smsNumber ? `<a class="btn full" style="background:#fff;color:#8e1b1b" href="sms:${esc(cfg.smsNumber)}?body=SOS">Send SOS by SMS</a>` : ''}
      ${cfg.ussdCode ? `<a class="btn full ghost" style="border-color:#fff;color:#fff" href="tel:${encodeURIComponent(cfg.ussdCode)}">Dial ${esc(cfg.ussdCode)}</a>` : ''}
      <a class="btn full" style="background:#fff;color:#8e1b1b" href="tel:${esc(cfg.emergencyNumber)}">Call ${esc(cfg.emergencyNumber)}</a></div>`);
  }

  // ---------- first-time tour ----------
  const TOUR = [
    { art: 'heart', title: (n) => `Welcome${n ? ', ' + n : ''}!`, text: 'MamaSafe helps you and your baby stay safe through pregnancy. Here is a one-minute tour.',
      list: ['Reminders before every clinic visit', 'A quick check for danger signs', 'One-tap emergency alerts', 'Hospitals near you, with phone numbers'] },
    { art: 'calendar', title: () => 'Your 8 clinic visits', text: 'We plan your visits from the first day of your last period, following the 8-contact schedule used in antenatal care.',
      list: ['SMS reminders 3 days before, 1 day before and on the day', 'Your next visit is always on the Home screen', 'Bring your antenatal card every time'] },
    { art: 'pulse', title: () => 'Not feeling right?', text: 'Open Check, tick what you feel, and MamaSafe tells you what to do: go now, get checked today, or mention it at your next visit.',
      list: ['It is a guide, not a diagnosis', 'If something feels wrong, go to a health facility even if it is not listed'] },
    { art: 'alert', red: true, title: () => 'In an emergency, press SOS', text: 'The red SOS button is always in the middle of the bottom bar.',
      list: ['Alerts your health facility, with your location if you allow it', 'Texts your emergency contact', 'Shows phone numbers to call straight away', 'Always free. Always works, even if you have not paid'] }
  ];

  function renderTour(i) {
    nav.hidden = true;
    const t = TOUR[i], last = i === TOUR.length - 1;
    const first = me && me.mother && me.mother.name ? me.mother.name : '';
    show(`<div class="tour">
      <div class="art ${t.red ? 'red' : ''}">${svg(ICON[t.art], 'stroke-width="1.6"')}</div>
      <h1>${esc(t.title(first))}</h1>
      <p>${esc(t.text)}</p>
      <ul>${t.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <div class="spacer"></div>
      <div class="dots" aria-label="Step ${i + 1} of ${TOUR.length}">${TOUR.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      <div class="btnrow">${i > 0 ? '<button class="ghost" id="prev" type="button">Back</button>' : ''}<button id="next" type="button">${last ? 'Start using MamaSafe' : 'Next'}</button></div>
      ${last ? '<button class="link" id="read" type="button">Read the full guide</button>' : '<button class="link" id="skip" type="button">Skip the tour</button>'}
    </div>`);
    const finish = (dest) => { store.set('ms_tour_done', '1'); go(dest || 'home'); };
    $('#next').onclick = () => (last ? finish() : renderTour(i + 1));
    const prev = $('#prev'); if (prev) prev.onclick = () => renderTour(i - 1);
    const skip = $('#skip'); if (skip) skip.onclick = () => finish();
    const read = $('#read'); if (read) read.onclick = () => { store.set('ms_tour_done', '1'); backView = 'home'; go('guide'); };
  }

  // ---------- user guide (works signed in or not, and offline once opened) ----------
  function openGuide() { if (view !== 'guide') backView = view === 'tour' ? 'home' : view; go('guide'); }

  function renderGuide() {
    const signedIn = !!(me && me.registered);
    if (!signedIn) nav.hidden = true;
    const ussd = cfg.ussdCode, sms = cfg.smsNumber, em = cfg.emergencyNumber || '999';
    const sec = (icon, title, body, open) => `<details class="card acc"${open ? ' open' : ''}><summary><span class="ico">${svg(ICON[icon])}</span>${title}</summary><div class="body">${body}</div></details>`;
    show(`<button class="ghost" id="gback" type="button" style="min-height:42px;margin-bottom:12px">&larr; Back</button>
      <div class="eyebrow">User guide</div>
      <h1>How to use MamaSafe</h1>
      <p class="muted" style="font-size:16px;margin:0">Everything you need in a few minutes. Tap a section to open it.</p>
      <div class="guide-hero"><b>In an emergency, do not read. Press SOS or call ${esc(em)}.</b><br>
        <span class="muted">Heavy bleeding, fits, severe headache with blurred vision, baby moving much less or not at all, severe belly pain, fluid leaking, high fever, difficulty breathing: go to a health facility straight away.</span></div>

      <h2>Getting started</h2>
      <ol class="steps card">
        <li><b>Sign in with your phone number</b><span class="muted">Type your number and tap <i>Send me a code</i>. We text you 6 digits. Type them in and tap Continue. You do not need a password.</span></li>
        <li><b>Tell us about your pregnancy</b><span class="muted">Your first name, the first day of your last period (look at a calendar or your diary), and your clinic. Tap <i>Use my location</i> to see the nearest clinics first, or type your district.</span></li>
        <li><b>Add someone we can alert</b><span class="muted">A husband, mother or friend. In an emergency we text them too. This is optional but recommended.</span></li>
        <li><b>Keep SMS reminders on</b><span class="muted">We text you before each clinic visit. You can turn this off any time on the Home screen.</span></li>
        <li><b>Add MamaSafe to your phone</b><span class="muted">Open the browser menu and choose <i>Add to Home screen</i> (iPhone: Share, then <i>Add to Home Screen</i>). It then opens like any other app.</span></li>
      </ol>

      <h2>What each screen does</h2>
      ${sec('home', 'Home', `<p>Shows your <b>week of pregnancy</b>, your trimester, your <b>due date</b> and your <b>next visit</b> with a button to call your clinic.</p><p>Below that you can turn SMS reminders on or off, and sign out.</p>`, true)}
      ${sec('calendar', 'Visits', `<p>Your 8 antenatal visits, planned from your due date: weeks 12, 20, 26, 30, 34, 36, 38 and 40. Visits already passed are faded and ticked. The highlighted one is next.</p><p>Bring your antenatal card to every visit.</p>`)}
      ${sec('pulse', 'Check my symptoms', `<p>Tap <b>Check</b> in the bottom bar and tick everything you feel. Tap <b>Check</b> at the bottom of the list. You will get one of three answers:</p>
        <table class="kv"><tr><td><span class="pill emergency">EMERGENCY</span></td><td>Go to a health facility now. A button lets you alert your clinic in one tap.</td></tr>
        <tr><td><span class="pill urgent">URGENT</span></td><td>Get checked by a midwife or doctor today. Do not wait for your next visit.</td></tr>
        <tr><td><span class="pill mild">MILD</span></td><td>Common in pregnancy. Tell the midwife at your next visit, and check again if you get worse.</td></tr></table>
        <p class="muted">This is a guide, not a diagnosis. If something feels wrong, go to a health facility even if it is not on the list.</p>`)}
      ${sec('alert', 'SOS (emergency alert)', `<p>The red <b>SOS</b> button sits in the middle of the bottom bar. Tap it, then tap <b>Send emergency alert</b>. MamaSafe will:</p>
        <ul><li>tell your health facility (with your location if your phone shares it)</li><li>text your emergency contact</li><li>text you a confirmation</li></ul>
        <p>If the facility has no mobile number for alerts, the app tells you honestly: <b>"We could not text them, please call"</b> and shows every phone number we hold. Press the call buttons.</p>
        <div class="callout red"><b>SOS does not send an ambulance.</b> Go to the facility if you can, and call ${esc(em)} if you cannot get there. Keep your phone with you.</div>
        <p class="muted">SOS, the symptom check and the hospital finder are always free for everyone.</p>`)}
      ${sec('pin', 'Care (find a hospital)', `<p>Works even before you sign in. Tap <b>Use my location</b> to sort by distance, or search by district or hospital name. Filter by <i>Hospitals</i>, <i>Health centres</i>, <i>Clinics</i> or <i>Open 24h</i>.</p>
        <p>Each place has <b>tap-to-call</b> buttons for every number we hold, a <b>Directions</b> link that opens Google Maps, and a map pin that matches the number on the list. Tap a pin to see the details.</p>
        <p>Some places show <i>No phone number on file</i>. We never guess a number. Details come from public sources and can be out of date, so call ahead when you can.</p>`)}

      <h2>No smartphone or no data?</h2>
      ${sec('phone', 'Use any phone: USSD and SMS', `<p>Everything important also works on a basic phone with no internet. Your phone number is your identity, so there is nothing to sign in to.</p>
        ${ussd ? `<p><b>Dial <code>${esc(ussd)}</code></b> and follow the menu:</p>` : '<p><b>Dial the MamaSafe code</b> (ask your clinic for it) and follow the menu:</p>'}
        <table class="kv"><tr><td>1</td><td>My next visit (or Register, if you are new)</td></tr><tr><td>2</td><td>I feel unwell: pick a danger sign</td></tr><tr><td>3</td><td>My health facility</td></tr><tr><td>4</td><td>EMERGENCY: sends an alert</td></tr><tr><td>5</td><td>Find a hospital: type the first letters of your district</td></tr></table>
        ${sms ? `<p><b>Text <code>HELP</code> to <code>${esc(sms)}</code></b> to see the options. Useful words:</p>` : '<p><b>Text these words</b> to the MamaSafe SMS number:</p>'}
        <table class="kv"><tr><td>REG</td><td><code>REG 150326 ABC Mary</code> registers you: last period date as DDMMYY, then your clinic code, then your name</td></tr>
        <tr><td>CLINICS</td><td><code>CLINICS Gulu</code> lists clinics in a district</td></tr>
        <tr><td>VISIT</td><td>your next visit date</td></tr><tr><td>CLINIC</td><td>your clinic and its numbers</td></tr>
        <tr><td>SYMPTOM</td><td>danger-sign check, for example <code>SYMPTOM 1 9</code></td></tr>
        <tr><td>SOS</td><td>sends an emergency alert</td></tr><tr><td>STOP / START</td><td>turn SMS reminders off or on</td></tr></table>
        <p class="muted">Alerts from basic phones cannot include your GPS location, only your registered clinic and area.</p>`)}

      <h2>Questions</h2>
      ${sec('question', 'I did not get my code', `<ul><li>Wait a minute and check your SMS inbox again.</li><li>Check you typed the number correctly, starting with 07.</li><li>Tap <i>Use a different number</i> and try again.</li><li>Still nothing? Use the Care screen or dial ${esc(em)} for emergencies. You do not need an account for those.</li></ul>`)}
      ${sec('user', 'I do not know my last period date', `<p>Pick your best guess. If you are unsure, ask your midwife at the clinic: an ultrasound scan can give a better date.</p>`)}
      ${sec('chat', 'Will it cost me money?', `<p>Emergency alerts, the danger-sign check and finding a hospital are <b>free</b>. Your service may charge a one-time fee to switch on SMS reminders. If it does, you will see a <b>Pay</b> card on the Home screen. We never see your card number or mobile money PIN.</p>`)}
      ${sec('shield', 'Who sees my information?', `<p>Your phone number, pregnancy dates, clinic and any alerts you send are visible to MamaSafe and to staff at health facilities who respond to alerts. They are used only for reminders and emergencies. Sign out on a shared phone using the button on Home.</p>`)}
      ${sec('install', 'The app says I am offline', `<p>MamaSafe still opens without signal and shows how to send SOS by SMS, dial the USSD code or call ${esc(em)}. Your reminders still arrive by SMS.</p>`)}

      <div class="card" style="text-align:center"><b>Still stuck?</b><p class="muted" style="margin:6px 0 0">Ask the midwife at your clinic. They can help you set up MamaSafe in a minute.</p></div>
      <a class="btn danger full" href="tel:${esc(em)}">Emergency: call ${esc(em)}</a>
      ${signedIn ? '<button class="ghost full" id="retour" type="button">Show the welcome tour again</button>' : ''}`);
    $('#gback').onclick = () => go(backView && backView !== 'guide' ? backView : (signedIn ? 'home' : 'auth'));
    const rt = $('#retour'); if (rt) rt.onclick = () => go('tour');
  }

  // ---------- find care near me (works signed in or not) ----------
  const CHIPS = [['', 'All'], ['hospital', 'Hospitals'], ['health_centre', 'Health centres'], ['clinic', 'Clinics'], ['open24', 'Open 24h']];

  async function renderCare() {
    const signedIn = !!(me && me.registered);
    if (!signedIn) nav.hidden = true;
    const lines = (cfg.helplines || []).filter((l) => l.confidence !== 'low');
    show(`${signedIn ? '' : '<button class="ghost" id="back" type="button" style="margin-bottom:10px">&larr; Back</button>'}
      <h1>Find a hospital near you</h1>
      <div class="card helplines"><div class="hl first"><div><b>Emergency</b><div class="muted">Police and general emergency. 112 also works.</div></div><a class="btn danger" href="tel:${esc(cfg.emergencyNumber)}">Call ${esc(cfg.emergencyNumber)}</a></div>
        ${lines.filter((l) => l.number !== cfg.emergencyNumber && l.kind !== 'emergency').length ? `<details><summary>Toll-free health lines</summary>
        ${lines.filter((l) => l.number !== cfg.emergencyNumber && l.kind !== 'emergency').map((l) => `<div class="hl"><div><b>${esc(l.name)}</b><div class="muted">${esc(l.note || '')}</div></div><a class="btn tf" href="${telHref(l.tel)}">${esc(l.number)}</a></div>`).join('')}
        ${cfg.helplinesChecked ? `<div class="muted">Numbers last checked ${esc(cfg.helplinesChecked)}.</div>` : ''}</details>` : ''}</div>
      <button class="full" id="loc" type="button">${pos ? 'Sorted by distance from you' : 'Use my location to find the nearest'}</button>
      <label for="q" class="sr">Search by district or name</label>
      <input id="q" type="search" placeholder="Search a district or facility name" value="${esc(care.q)}" autocomplete="off" style="margin-top:12px">
      <div class="chips" role="group" aria-label="Filter">${CHIPS.map(([v, t]) => `<button type="button" class="chip" data-chip="${v}" aria-pressed="${(v === 'open24' ? care.open24 : !care.open24 && care.kind === v)}">${t}</button>`).join('')}</div>
      <div id="map" role="region" aria-label="Map of health facilities"></div>
      <p id="count" class="muted" aria-live="polite"></p>
      <div id="results"></div>
      <button class="ghost full" id="more" type="button" hidden>Show more</button>
      <p class="muted">Facility details come from public sources and may be out of date. Always call ahead if you can; in an emergency go to the nearest hospital or call ${esc(cfg.emergencyNumber)}.</p>`);
    const back = $('#back'); if (back) back.onclick = () => go('auth');
    $('#loc').onclick = async () => { say('Finding your location…'); pos = await locate(); say(pos ? '' : 'Could not get your location. You can still search by district.', !pos); if (pos) { $('#loc').textContent = 'Sorted by distance from you'; refreshCare(); } };
    let timer = null;
    $('#q').oninput = (e) => { care.q = e.target.value; care.limit = 20; clearTimeout(timer); timer = setTimeout(refreshCare, 300); };
    document.querySelector('.chips').onclick = (e) => {
      const c = e.target.closest('[data-chip]'); if (!c) return;
      const v = c.dataset.chip;
      care.open24 = v === 'open24'; care.kind = v === 'open24' ? '' : v; care.limit = 20;
      document.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', x.dataset.chip === 'open24' ? care.open24 : !care.open24 && care.kind === x.dataset.chip));
      refreshCare();
    };
    $('#more').onclick = () => { care.limit = Math.min(care.limit + 20, 100); refreshCare(); };
    // The list never waits for the map: on a slow connection the numbers matter more than the pins.
    mapHandle = createMap($('#map'), (f) => {
      const card = document.getElementById('fac-' + f.id);
      if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600); }
    });
    refreshCare();
  }

  let careSeq = 0;
  async function refreshCare() {
    const seq = ++careSeq;
    const qs = new URLSearchParams({ limit: String(care.limit) });
    if (care.q.trim()) qs.set('q', care.q.trim());
    if (care.kind) qs.set('kind', care.kind);
    if (care.open24) qs.set('open24', '1');
    if (pos) { qs.set('lat', pos.lat); qs.set('lng', pos.lng); }
    let data;
    try { data = await api('/api/facilities?' + qs); } catch (e) { say(e.status ? e.message : 'No internet connection. Call ' + cfg.emergencyNumber + ' in an emergency.', true); return; }
    if (seq !== careSeq || view !== 'care') return; // a newer search or another screen took over
    say('');
    const { facilities, total } = data;
    $('#count').textContent = total ? `Showing ${facilities.length} of ${total}${pos ? ', nearest first' : ''}.` : '';
    $('#more').hidden = facilities.length >= total || care.limit >= 100;
    $('#results').innerHTML = facilities.length ? facilities.map((f, i) => `<div class="card fac" id="fac-${f.id}">
      <div class="fac-head"><span class="num">${i + 1}</span><div><h3>${esc(f.name)}</h3>
      <div class="muted">${esc(KIND[f.kind] || 'Facility')}${f.level ? ' · ' + esc(f.level) : ''} · ${esc(f.area)}${f.distanceKm != null ? ' · <b>' + f.distanceKm + ' km</b>' : ''}</div></div></div>
      <div class="tags">${f.open24 === true ? '<span class="tag ok">Open 24 hours</span>' : f.open24 === false ? '<span class="tag">Daytime only</span>' : '<span class="tag">Hours not confirmed</span>'}</div>
      ${f.services ? `<div class="muted">${esc(f.services)}</div>` : ''}
      ${contactHtml(f)}
      <div class="row"><a class="btn ghost" target="_blank" rel="noopener" href="${esc(dirUrl(f))}">Directions</a>${safeUrl(f.website) ? `<a class="btn ghost" target="_blank" rel="noopener" href="${esc(f.website)}">Website</a>` : ''}${f.email ? `<a class="btn ghost" href="mailto:${esc(f.email)}">Email</a>` : ''}</div></div>`).join('')
      : '<div class="card"><b>No facility found.</b><p class="muted">Try a different spelling, or the name of your district. Facilities in this list are being added; call ' + esc(cfg.emergencyNumber) + ' in an emergency.</p></div>';
    if (mapHandle) mapHandle.set(facilities, pos);
  }

  // ---------- maps: Google when a key is configured, OpenStreetMap otherwise ----------
  let googleLoading = null;
  function loadGoogle() {
    if (!cfg.googleMapsKey) return Promise.reject(new Error('no key'));
    if (googleLoading) return googleLoading;
    googleLoading = new Promise((resolve, reject) => {
      window.__gmReady = () => resolve();
      window.gm_authFailure = () => { googleLoading = Promise.reject(new Error('auth')); googleLoading.catch(() => {}); if (mapHandle && mapHandle.google) mapHandle.fallback(); };
      const sc = document.createElement('script');
      sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.googleMapsKey)}&loading=async&libraries=maps,marker&callback=__gmReady&v=weekly`;
      sc.async = true;
      sc.onerror = () => reject(new Error('load failed'));
      document.head.appendChild(sc);
    });
    googleLoading.catch(() => {});
    return googleLoading;
  }

  function createMap(el, onSelect) {
    let impl = null, dead = false, last = null;
    const handle = {
      google: false,
      set(list, you) { last = { list, you }; if (impl) impl.set(list, you); },
      destroy() { dead = true; if (impl) impl.destroy(); impl = null; },
      fallback() {
        if (impl) impl.destroy();
        el.innerHTML = ''; handle.google = false;
        impl = leafletMap(el, onSelect);
        if (impl) { if (last) impl.set(last.list, last.you); }
        else if (el.isConnected) el.outerHTML = '<p class="muted">The map could not load. The list below still works.</p>';
      }
    };
    loadGoogle()
      .then(() => googleMap(el, onSelect))
      .then((m) => { if (dead) return m.destroy(); impl = m; handle.google = true; if (last) impl.set(last.list, last.you); })
      .catch(() => { if (!dead) handle.fallback(); });
    return handle;
  }

  function popupNode(f) {
    const d = document.createElement('div');
    d.className = 'pop';
    const b = document.createElement('b'); b.textContent = f.name; d.appendChild(b);
    const p = document.createElement('div'); p.textContent = `${KIND[f.kind] || 'Facility'} · ${f.area}`; d.appendChild(p);
    const tel = bestPhone(f);
    if (tel) { const a = document.createElement('a'); a.href = telHref(tel); a.textContent = 'Call ' + fmtPhone(tel); d.appendChild(a); d.appendChild(document.createTextNode(' · ')); }
    const g = document.createElement('a'); g.href = dirUrl(f); g.target = '_blank'; g.rel = 'noopener'; g.textContent = 'Directions'; d.appendChild(g);
    return d;
  }

  async function googleMap(el, onSelect) {
    const { Map, InfoWindow } = await google.maps.importLibrary('maps');
    const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary('marker');
    const map = new Map(el, { center: { lat: 1.37, lng: 32.29 }, zoom: 7, mapId: cfg.googleMapId || 'DEMO_MAP_ID', mapTypeControl: false, streetViewControl: false, fullscreenControl: false, gestureHandling: 'cooperative' });
    const info = new InfoWindow();
    let markers = [];
    return {
      set(list, you) {
        markers.forEach((m) => { m.map = null; }); markers = [];
        const bounds = new google.maps.LatLngBounds();
        list.forEach((f, i) => {
          if (f.lat == null) return;
          const pin = new PinElement({ glyph: String(i + 1), glyphColor: '#fff', background: f.open24 ? '#0f6e6e' : '#4f6463', borderColor: '#fff' });
          const m = new AdvancedMarkerElement({ map, position: { lat: f.lat, lng: f.lng }, content: pin.element, title: f.name });
          m.addListener('click', () => { info.setContent(popupNode(f)); info.open({ map, anchor: m }); onSelect(f); });
          markers.push(m); bounds.extend({ lat: f.lat, lng: f.lng });
        });
        if (you) {
          const dot = document.createElement('div'); dot.className = 'youdot';
          markers.push(new AdvancedMarkerElement({ map, position: { lat: you.lat, lng: you.lng }, content: dot, title: 'You are here' }));
          bounds.extend({ lat: you.lat, lng: you.lng });
        }
        if (!bounds.isEmpty()) map.fitBounds(bounds, 40);
        if (markers.length === 1) map.setZoom(Math.min(map.getZoom() || 14, 14));
      },
      destroy() { markers.forEach((m) => { m.map = null; }); markers = []; el.innerHTML = ''; }
    };
  }

  function leafletMap(el, onSelect) {
    if (!window.L) return null;
    const map = L.map(el, { scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    map.setView([1.37, 32.29], 7);
    let layer = L.layerGroup().addTo(map);
    return {
      set(list, you) {
        layer.clearLayers();
        const bounds = [];
        list.forEach((f, i) => {
          if (f.lat == null) return;
          L.marker([f.lat, f.lng], { title: f.name, icon: L.divIcon({ className: '', html: `<span class="lpin ${f.open24 ? 'h24' : ''}">${i + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }) })
            .addTo(layer).bindPopup(popupNode(f)).on('click', () => onSelect(f));
          bounds.push([f.lat, f.lng]);
        });
        if (you) { L.circleMarker([you.lat, you.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#1d5fd0', fillOpacity: 1 }).addTo(layer).bindTooltip('You are here'); bounds.push([you.lat, you.lng]); }
        if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
      },
      destroy() { map.remove(); }
    };
  }

  $('#helpbtn').onclick = () => openGuide();
  nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) go(b.dataset.view); });

  (async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    try { cfg = await api('/api/config'); } catch { /* offline: defaults */ }
    if (!token) return go('auth');
    try {
      await loadMe();
      const back = new URLSearchParams(location.search).get('payment');
      if (back) history.replaceState(null, '', '/');
      await go(me.registered ? 'home' : 'register');
      if (back === 'success') say('Payment received. Thank you!');
      else if (back === 'failed') say('The payment did not go through. You were not charged, or the money will return to you. Please try again.', true);
      else if (back === 'pending') say('We are waiting for confirmation of your payment. This can take a few minutes.');
    } catch (e) {
      if (e.status === 401) return signOut();
      // Offline or server down: still offer the emergency fallbacks.
      nav.hidden = true;
      showSosFallback('You seem to be offline.');
    }
  })();
})();

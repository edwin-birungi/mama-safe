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
  let cfg = { ussdCode: '', smsNumber: '', emergencyNumber: '999' };
  let token = store.get('ms_token');
  let me = null;
  let pos = null;
  let mapInstance = null;
  let view = 'home';
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
    if (mapInstance) { mapInstance.remove(); mapInstance = null; }
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
      show(`<h1>Welcome. Let's keep you and your baby safe.</h1>
        <p class="muted">Enter your phone number. We will text you a code. We use your number for visit reminders and emergency alerts.</p>
        <form id="f"><label for="phone">Your phone number</label>
        <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0712 345 678" required>
        <button class="full" type="submit">Send me a code</button></form>
        ${basicPhoneCard()}`);
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
    const { facilities } = await api('/api/facilities' + (pos ? `?lat=${pos.lat}&lng=${pos.lng}` : ''));
    show(`<h1>Tell us about your pregnancy</h1>
      <p class="muted">This sets up your visit schedule and finds your nearest clinic.</p>
      <form id="f">
        <label for="name">Your first name</label>
        <input id="name" type="text" autocomplete="given-name" maxlength="40">
        <label for="lmp">First day of your last period</label>
        <input id="lmp" type="date" min="${isoDaysAgo(280)}" max="${isoToday()}" required>
        <label for="fac">Your health facility</label>
        <select id="fac"><option value="">Choose…</option>${facilities.map((f) => `<option value="${f.id}">${esc(f.name)}${f.distanceKm != null ? ' · ' + f.distanceKm + ' km' : ''}</option>`).join('')}</select>
        <button class="ghost" type="button" id="loc" style="margin-top:10px">Use my location to sort by distance</button>
        <label for="contact">Phone of someone we can alert in an emergency</label>
        <input id="contact" type="tel" inputmode="tel" autocomplete="off" placeholder="Husband, mother, friend (optional)">
        <label class="check"><input id="sms" type="checkbox" checked> Send visit reminders by SMS</label>
        <button class="full" type="submit">Create my profile</button>
      </form>`);
    $('#loc').onclick = async () => { say('Finding your location…'); pos = await locate(); say(pos ? '' : 'Could not get your location. You can still choose a facility from the list.', !pos); if (pos) renderRegister(); };
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#f button[type=submit]'); btn.disabled = true;
      try {
        me = await api('/api/register', { method: 'POST', body: { name: $('#name').value, lmp: $('#lmp').value, facilityId: $('#fac').value || null, contactPhone: $('#contact').value, smsOptin: $('#sms').checked } });
        go('home');
      } catch (err) { say(err.message, true); btn.disabled = false; }
    };
  }

  // ---------- home ----------
  function renderHome() {
    const g = me.gestation, pct = Math.min(100, Math.round((g.totalDays / 280) * 100));
    const next = me.next;
    show(`<div class="hero"><div class="muted" style="color:#d6eeeb">Hello${me.mother.name ? ', ' + esc(me.mother.name) : ''}</div>
      <div class="big">Week ${g.weeks}</div>
      <div class="bar" role="img" aria-label="${pct} percent of pregnancy"><span style="width:${pct}%"></span></div>
      <div style="color:#d6eeeb;font-size:14px">Due about ${fmtDate(me.edd)}</div></div>
      <div class="card">${next
        ? `<div class="muted"><b>NEXT VISIT · ${next.no} OF 8</b></div><div style="font-size:20px;font-weight:800">${fmtDate(next.date)}</div><div class="muted">${me.facility ? esc(me.facility.name) : 'No facility chosen yet'}</div>`
        : '<b>No more visits planned.</b> Your baby is due soon. Text or tap SOS if you need urgent help.'}</div>
      <div class="danger-note"><b>Know the danger signs.</b> Heavy bleeding, fits, severe headache with blurred vision, or baby moving much less: go to a health facility straight away and press SOS.</div>
      ${basicPhoneCard()}
      <h2>Settings</h2>
      <div class="card"><label class="check"><input id="optin" type="checkbox" ${me.mother.smsOptin ? 'checked' : ''}> SMS visit reminders</label>
      <button class="ghost full" id="out" type="button">Sign out</button></div>`);
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
      <form id="f">${groups.map(([lvl, title]) => `<h2><span class="pill ${lvl}">${lvl.toUpperCase()}</span> ${title}</h2>` +
        symptoms.filter((s) => s.level === lvl).map((s) => `<label class="check"><input type="checkbox" name="s" value="${esc(s.id)}"> ${esc(s.label)}</label>`).join('')).join('')}
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
    show(`<div class="sosview"><h1>Alert sent</h1><p class="muted">Go to the facility now if you can. Keep your phone with you.</p>
      <div class="card"><b>${f ? esc(f.name) : 'Your facility'} has been told.</b>${f && f.phone ? `<div class="muted" style="color:var(--muted)">Tel ${esc(f.phone)}</div>` : ''}</div>
      <div class="card"><b>Your emergency contact has been told.</b></div>
      ${f && f.phone ? `<a class="btn full" style="background:#fff;color:#8e1b1b" href="tel:${esc(f.phone)}">Call the facility</a>` : ''}
      ${f && f.lat != null ? `<a class="btn full ghost" style="border-color:#fff;color:#fff" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${f.lat},${f.lng}">Directions</a>` : ''}
      <a class="btn full ghost" style="border-color:#fff;color:#fff" href="tel:${esc(cfg.emergencyNumber)}">Call ${esc(cfg.emergencyNumber)}</a></div>`);
  }

  // If the app cannot reach the server, SMS and calls still work without data.
  function showSosFallback(reason) {
    show(`<div class="sosview"><h1>Could not send the alert</h1><p class="muted">${esc(reason)} Use one of these instead:</p>
      ${cfg.smsNumber ? `<a class="btn full" style="background:#fff;color:#8e1b1b" href="sms:${esc(cfg.smsNumber)}?body=SOS">Send SOS by SMS</a>` : ''}
      ${cfg.ussdCode ? `<a class="btn full ghost" style="border-color:#fff;color:#fff" href="tel:${encodeURIComponent(cfg.ussdCode)}">Dial ${esc(cfg.ussdCode)}</a>` : ''}
      <a class="btn full" style="background:#fff;color:#8e1b1b" href="tel:${esc(cfg.emergencyNumber)}">Call ${esc(cfg.emergencyNumber)}</a></div>`);
  }

  // ---------- care near me ----------
  async function renderCare() {
    const q = pos ? `?lat=${pos.lat}&lng=${pos.lng}` : '';
    const { facilities } = await api('/api/facilities' + q);
    show(`<h1>Care near you</h1><p class="muted">${pos ? 'Nearest first' : 'Allow location to sort by distance'}.</p>
      ${pos ? '' : '<button class="ghost" id="loc" type="button">Use my location</button>'}
      <div id="map" role="img" aria-label="Map of nearby health facilities"></div>
      ${facilities.map((f) => `<div class="card fac"><h3>${esc(f.name)}</h3>
        <div class="muted">${esc(f.area)}${f.distanceKm != null ? ' · ' + f.distanceKm + ' km' : ''} · ${f.open24 ? 'Open 24 hours' : 'Daytime only'}</div>
        ${f.services ? `<div class="muted">${esc(f.services)}</div>` : ''}
        <div class="row">${f.phone ? `<a class="btn ghost" href="tel:${esc(f.phone)}">Call</a>` : ''}${f.lat != null ? `<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${f.lat},${f.lng}">Directions</a>` : ''}</div></div>`).join('')}`);
    const loc = $('#loc');
    if (loc) loc.onclick = async () => { say('Finding your location…'); pos = await locate(); say(pos ? '' : 'Could not get your location.', !pos); renderCare(); };
    drawMap(facilities);
  }

  function drawMap(facilities) {
    const el = $('#map');
    if (!window.L) { el.outerHTML = '<p class="muted">The map could not load (no internet?). The list below still works.</p>'; return; }
    const pts = facilities.filter((f) => f.lat != null);
    mapInstance = L.map(el, { scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(mapInstance);
    const bounds = [];
    pts.forEach((f, i) => {
      L.circleMarker([f.lat, f.lng], { radius: 11, color: '#fff', weight: 2, fillColor: f.open24 ? '#0f6e6e' : '#4f6463', fillOpacity: 1 })
        .addTo(mapInstance).bindTooltip(`${i + 1}. ${f.name}`);
      bounds.push([f.lat, f.lng]);
    });
    if (pos) { L.circleMarker([pos.lat, pos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#1d5fd0', fillOpacity: 1 }).addTo(mapInstance).bindTooltip('You are here'); bounds.push([pos.lat, pos.lng]); }
    if (bounds.length) mapInstance.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 }); else mapInstance.setView([1.37, 32.29], 7);
  }

  nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) go(b.dataset.view); });

  (async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    try { cfg = await api('/api/config'); } catch { /* offline: defaults */ }
    if (!token) return go('auth');
    try {
      await loadMe();
      go(me.registered ? 'home' : 'register');
    } catch (e) {
      if (e.status === 401) return signOut();
      // Offline or server down: still offer the emergency fallbacks.
      nav.hidden = true;
      showSosFallback('You seem to be offline.');
    }
  })();
})();

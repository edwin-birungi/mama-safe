(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const staffStore = {
    get() {
      let saved = null;
      try { saved = localStorage.getItem('ms_staff_token'); } catch { /* try the prior tab-scoped session */ }
      if (saved) return saved;
      let legacy = null;
      try { legacy = sessionStorage.getItem('ms_staff_token'); } catch { return null; }
      if (legacy) {
        try { localStorage.setItem('ms_staff_token', legacy); } catch { /* storage unavailable */ }
        try { sessionStorage.removeItem('ms_staff_token'); } catch { /* storage unavailable */ }
      }
      return legacy;
    },
    set(value) { try { localStorage.setItem('ms_staff_token', value); } catch { try { sessionStorage.setItem('ms_staff_token', value); } catch { /* storage unavailable */ } } },
    del() { try { localStorage.removeItem('ms_staff_token'); } catch { /* storage unavailable */ } try { sessionStorage.removeItem('ms_staff_token'); } catch { /* storage unavailable */ } }
  };
  let tab = 'alerts', soundOn = false, knownNew = null, audio = null, staffToken = staffStore.get(), refreshTimer = null, authMode = 'login';

  const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };

  function beep() {
    if (!soundOn) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const first = audio.currentTime + 0.03;
      [0, 0.82, 1.64].forEach((delay, i) => {
        const start = first + delay;
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = i === 1 ? 740 : 880;
        o.connect(g); g.connect(audio.destination);
        g.gain.setValueAtTime(0.001, start);
        g.gain.linearRampToValueAtTime(0.16, start + 0.04);
        g.gain.setValueAtTime(0.16, start + 0.54);
        g.gain.exponentialRampToValueAtTime(0.001, start + 0.68);
        o.start(start); o.stop(start + 0.7);
      });
    } catch { /* no audio */ }
  }

  async function j(path, opts) {
    opts = opts || {};
    const headers = { ...(opts.headers || {}) };
    if (staffToken) headers.Authorization = `Bearer ${staffToken}`;
    const r = await fetch(path, { ...opts, headers });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }

  async function loadAlerts() {
    const fac = $('#fac').value;
    const d = await j('/api/admin/alerts' + (fac ? `?facility=${encodeURIComponent(fac)}` : ''));
    const sel = $('#fac');
    if (sel.options.length === 1) d.facilities.forEach((f) => sel.add(new Option(f.name, f.id)));
    const fresh = d.alerts.filter((a) => a.status === 'new');
    if (knownNew !== null && fresh.some((a) => !knownNew.has(a.id))) beep();
    knownNew = new Set(fresh.map((a) => a.id));
    const st = $('#stats');
    st.hidden = !d.alerts.length;
    st.innerHTML = `<div class="stat ${fresh.length ? 'hot' : ''}"><b>${fresh.length}</b><span>waiting for a response</span></div>
      <div class="stat"><b>${d.alerts.length - fresh.length}</b><span>acknowledged</span></div>
      <div class="stat"><b>${d.alerts.filter((a) => !a.notified && a.status === 'new').length}</b><span>not sent by SMS</span></div>`;
    $('#alerts').innerHTML = d.alerts.length ? d.alerts.map((a) => `
      <article class="card alert ${esc(a.status)}">
        <div class="head">
          <b>${a.status === 'new' ? '<span class="pill emergency">NEW EMERGENCY</span>' : '<span class="pill mild">ACKNOWLEDGED</span>'} #${a.id}</b><span class="meta">${when(a.created_at)} · ${ago(a.created_at)}</span></div>
        <div class="who">${esc(a.mother_name || 'Mother')} · <a href="tel:${esc(a.mother_phone)}">${esc(a.mother_phone)}</a></div>
        <div>Week ${a.weeks} · ${esc(a.symptomLabels.join(', '))}</div>
        <div class="meta">Via ${esc(a.channel)} · ${esc(a.facility_name || 'no facility')}${a.lat != null ? ` · <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=16/${a.lat}/${a.lng}">her location</a>` : ' · no GPS'}${a.contact_phone ? ` · contact ${esc(a.contact_phone)}${a.contact_verified ? ' (confirmed)' : ' (not confirmed)'}` : ''}</div>
        ${a.transport && a.transport.length ? `<div class="meta">Transport: ${a.transport.map((x) => `${esc(x.name)} ${esc(x.phone)} <b>${x.status === 'accepted' ? 'ACCEPTED' : x.status === 'taken' ? 'not needed' : 'asked'}</b>`).join(' · ')}</div>` : ''}
        ${a.notified ? '' : `<div class="meta bad">The facility was NOT sent an SMS (no alert mobile on file). Phone them: ${esc([a.facility_emergency_phone, a.facility_phone, a.facility_toll_free].filter(Boolean).join(' / ') || 'no number on file')}</div>`}
        ${a.status === 'new' ? `<button data-ack="${a.id}" style="margin-top:10px">I am acting on this</button>` : `<div class="meta">Acknowledged ${a.ack_at ? when(a.ack_at) : ''} by ${esc(a.ack_by || '')}</div>`}
      </article>`).join('') : '<div class="card empty"><b>No alerts yet</b>New emergencies will appear here automatically.</div>';
  }

  async function loadMsgs() {
    const d = await j('/api/admin/outbox');
    $('#smswarn').hidden = d.sms.live;
    $('#msgs').innerHTML = `<div class="tablewrap"><table><thead><tr><th>When</th><th>To</th><th>Type</th><th>Status</th><th>Message</th></tr></thead><tbody>${
      d.messages.map((m) => `<tr><td>${when(m.created_at)}</td><td>${esc(m.to_phone)}</td><td>${esc(m.kind)}</td><td>${esc(m.status)}${m.error ? '<br>' + esc(m.error) : ''}</td><td>${esc(m.body)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  async function loadTransport() {
    const d = await j('/api/admin/transport');
    const kind = $('#tp-kind');
    if (!kind.options.length) d.kinds.forEach((k) => kind.add(new Option(k, k)));
    $('#tplist').innerHTML = d.transport.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Kind</th><th>Mobile</th><th>District</th><th>GPS base</th><th>Radius</th><th>Driver says</th><th>Listed</th><th></th></tr></thead><tbody>${
      d.transport.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.kind)}</td><td>${esc(p.phone)}</td><td>${esc(p.area || '')}</td><td>${p.lat != null ? 'yes' : 'no (district only)'}</td><td>${esc(p.radius_km)} km</td><td>${p.available ? 'available' : 'busy'}</td><td>${p.active ? 'yes' : 'hidden'}</td><td><button class="ghost" data-tp="${p.id}" data-active="${p.active ? 0 : 1}">${p.active ? 'Hide' : 'List again'}</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="card empty"><b>No drivers yet</b>Until you add some, an emergency alert cannot ask anyone to collect the mother. Add them above or with <code>npm run import:transport</code>.</div>';
  }

  async function loadQuestions() {
    const d = await j('/api/admin/questions');
    $('#questions').innerHTML = d.questions.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Mother</th><th>Clinic</th><th>Question</th><th></th></tr></thead><tbody>${
      d.questions.map((q) => `<tr><td>${when(q.created_at)}</td><td>${esc(q.mother_name || '')}<br>${esc(q.mother_phone)}</td><td>${esc(q.facility_name || 'none chosen')}${q.notified ? '' : '<br><b>not texted</b>'}</td><td>${esc(q.text)}</td><td><button class="ghost" data-q="${q.id}">Done</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="card empty"><b>No open questions</b>When a mother sends a question from Ask MamaSafe, it appears here.</div>';
  }

  async function loadFacilities() {
    const d = await j('/api/admin/facilities');
    $('#facilities').innerHTML = d.facilities.length ? d.facilities.map((f) => `
      <form class="card facility-card" data-facility="${f.id}">
        <div class="facility-head"><div><b>${esc(f.name)}</b><div class="meta">${esc(f.area)} · ${esc(f.kind || 'facility')} · ${esc(f.code)}</div></div><span class="meta">${f.alert_phone ? 'Emergency SMS configured' : 'Emergency SMS not configured'}</span></div>
        <p class="muted">The alert mobile receives emergency texts. Confirm each number with the facility before saving.</p>
        <div class="facility-fields">
          <label>Main phone<input type="tel" name="phone" value="${esc(f.phone || '')}" autocomplete="off"></label>
          <label>Emergency phone<input type="tel" name="emergency_phone" value="${esc(f.emergency_phone || '')}" autocomplete="off"></label>
          <label>Toll-free phone<input type="tel" name="toll_free" value="${esc(f.toll_free || '')}" autocomplete="off"></label>
          <label>Emergency alert mobile<input type="tel" name="alert_phone" value="${esc(f.alert_phone || '')}" autocomplete="off"></label>
          <label>Open 24 hours<select name="open24"><option value="unknown" ${f.open24 == null ? 'selected' : ''}>Not confirmed</option><option value="true" ${f.open24 === true ? 'selected' : ''}>Yes</option><option value="false" ${f.open24 === false ? 'selected' : ''}>No</option></select></label>
        </div>
        <div class="facility-actions"><button type="submit">Save facility</button><span class="meta save-status" role="status" aria-live="polite"></span></div>
      </form>`).join('') : '<div class="card empty"><b>No facilities found</b>Import facility data to add facilities.</div>';
  }

  async function refresh() {
    try {
      $('#err').hidden = true;
      if (tab === 'alerts') await loadAlerts(); else if (tab === 'transport') await loadTransport(); else if (tab === 'questions') await loadQuestions(); else if (tab === 'facilities') await loadFacilities(); else await loadMsgs();
      if (tab === 'alerts') { const d = await j('/api/admin/outbox'); $('#smswarn').hidden = d.sms.live; }
    } catch (e) { $('#err').textContent = e.message; $('#err').hidden = false; }
  }

  function setTab(t) {
    tab = t;
    $('#tab-alerts').setAttribute('aria-pressed', t === 'alerts');
    $('#tab-msgs').setAttribute('aria-pressed', t === 'msgs');
    $('#tab-transport').setAttribute('aria-pressed', t === 'transport');
    $('#tab-questions').setAttribute('aria-pressed', t === 'questions');
    $('#tab-facilities').setAttribute('aria-pressed', t === 'facilities');
    $('#questions').hidden = t !== 'questions';
    $('#facilities').hidden = t !== 'facilities';
    $('#transport').hidden = t !== 'transport';
    if (t !== 'alerts') $('#stats').hidden = true;
    $('#alerts').hidden = t !== 'alerts';
    $('#msgs').hidden = t !== 'msgs';
    refresh();
  }

  $('#tab-alerts').onclick = () => setTab('alerts');
  $('#tab-msgs').onclick = () => setTab('msgs');
  $('#tab-transport').onclick = () => setTab('transport');
  $('#tab-questions').onclick = () => setTab('questions');
  $('#tab-facilities').onclick = () => setTab('facilities');
  $('#facilities').addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-facility]'); if (!form) return;
    e.preventDefault();
    const button = form.querySelector('button[type=submit]'), status = form.querySelector('.save-status');
    button.disabled = true; status.textContent = 'Saving…';
    const value = (name) => form.elements[name].value.trim();
    const open24 = value('open24');
    const body = {
      phone: value('phone'), emergency_phone: value('emergency_phone'), toll_free: value('toll_free'), alert_phone: value('alert_phone'),
      open24: open24 === 'unknown' ? null : open24 === 'true'
    };
    try {
      await j(`/api/admin/facilities/${form.dataset.facility}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      status.textContent = 'Saved.';
      $('#err').hidden = true;
    } catch (err) {
      status.textContent = '';
      $('#err').textContent = err.message; $('#err').hidden = false;
    } finally { button.disabled = false; }
  });
  $('#questions').addEventListener('click', async (e) => {
    const id = e.target.dataset && e.target.dataset.q; if (!id) return;
    e.target.disabled = true;
    try { await j(`/api/admin/questions/${id}`, { method: 'PATCH' }); } catch (err) { $('#err').textContent = err.message; $('#err').hidden = false; }
    refresh();
  });
  $('#tpform').onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: $('#tp-name').value, kind: $('#tp-kind').value, phone: $('#tp-phone').value, area: $('#tp-area').value };
    for (const [k, id] of [['lat', '#tp-lat'], ['lng', '#tp-lng'], ['radius_km', '#tp-radius']]) if ($(id).value.trim() !== '') body[k] = $(id).value.trim();
    try {
      await j('/api/admin/transport', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      $('#tpform').reset();
      $('#err').hidden = true;
    } catch (err) { $('#err').textContent = err.message; $('#err').hidden = false; }
    refresh();
  };
  $('#tplist').addEventListener('click', async (e) => {
    const id = e.target.dataset && e.target.dataset.tp;
    if (!id) return;
    e.target.disabled = true;
    try { await j(`/api/admin/transport/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: e.target.dataset.active === '1' }) }); } catch (err) { $('#err').textContent = err.message; $('#err').hidden = false; }
    refresh();
  });
  $('#fac').onchange = refresh;
  $('#sound').onclick = (e) => {
    soundOn = !soundOn;
    e.target.setAttribute('aria-pressed', soundOn);
    e.target.textContent = 'Sound alert: ' + (soundOn ? 'on' : 'off');
    if (soundOn) beep();
  };
  $('#alerts').addEventListener('click', async (e) => {
    const id = e.target.dataset && e.target.dataset.ack;
    if (!id) return;
    e.target.disabled = true;
    try { await j(`/api/admin/alerts/${id}/ack`, { method: 'POST' }); } catch (err) { $('#err').textContent = err.message; $('#err').hidden = false; }
    refresh();
  });

  function showDashboard(staff) {
    $('#staff-auth').hidden = true;
    $('#wrap').hidden = false;
    $('#staff-tools').hidden = false;
    $('#staff-name').textContent = staff.name || staff.email || 'Staff';
    refresh();
    if (!refreshTimer) refreshTimer = setInterval(() => { if (tab !== 'facilities') refresh(); }, 8000);
  }

  function showSignIn() {
    $('#staff-auth').hidden = false;
    $('#wrap').hidden = true;
    $('#staff-tools').hidden = true;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  function setAuthMode(mode) {
    authMode = mode;
    const registering = mode === 'register';
    $('#staff-auth-title').textContent = registering ? 'Create a staff account' : 'Facility staff sign in';
    $('#staff-name-wrap').hidden = !registering;
    $('#staff-invite-wrap').hidden = !registering;
    $('#staff-identifier').type = registering ? 'email' : 'text';
    $('#staff-identifier').autocomplete = registering ? 'email' : 'username';
    $('#staff-identifier-label').textContent = registering ? 'Work email' : 'Email or dashboard username';
    $('#staff-password').autocomplete = registering ? 'new-password' : 'current-password';
    $('#staff-auth-submit').textContent = registering ? 'Create account' : 'Sign in';
    $('#staff-login-tab').setAttribute('aria-pressed', String(!registering));
    $('#staff-register-tab').setAttribute('aria-pressed', String(registering));
    $('#staff-auth-error').hidden = true;
  }

  $('#staff-login-tab').onclick = () => setAuthMode('login');
  $('#staff-register-tab').onclick = () => setAuthMode('register');
  $('#staff-auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const error = $('#staff-auth-error'), submit = $('#staff-auth-submit');
    error.hidden = true; submit.disabled = true;
    const body = authMode === 'register'
      ? { name: $('#staff-name-input').value.trim(), email: $('#staff-identifier').value.trim(), password: $('#staff-password').value, inviteCode: $('#staff-invite').value }
      : { identifier: $('#staff-identifier').value.trim(), password: $('#staff-password').value };
    try {
      const data = await j(authMode === 'register' ? '/api/admin/account/register' : '/api/admin/account/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      staffToken = data.token;
      staffStore.set(staffToken);
      $('#staff-auth-form').reset();
      setAuthMode('login');
      showDashboard(data.staff);
    } catch (err) { error.textContent = err.message; error.hidden = false; }
    finally { submit.disabled = false; }
  };
  $('#staff-logout').onclick = async () => {
    try { await j('/api/admin/account/logout', { method: 'POST' }); } catch { /* clear local access even if offline */ }
    staffToken = null; staffStore.del();
    showSignIn(); setAuthMode('login');
  };

  (async () => {
    if (!staffToken) { showSignIn(); return; }
    try { const d = await j('/api/admin/session'); showDashboard(d.staff); }
    catch { staffToken = null; staffStore.del(); showSignIn(); }
  })();
})();

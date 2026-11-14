(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let tab = 'alerts', soundOn = false, knownNew = null, audio = null;

  const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };

  function beep() {
    if (!soundOn) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.connect(g); g.connect(audio.destination); o.frequency.value = 880; g.gain.value = 0.15;
      o.start(); o.stop(audio.currentTime + 0.4);
    } catch { /* no audio */ }
  }

  async function j(path, opts) {
    const r = await fetch(path, opts);
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

  async function refresh() {
    try {
      $('#err').hidden = true;
      if (tab === 'alerts') await loadAlerts(); else if (tab === 'transport') await loadTransport(); else if (tab === 'questions') await loadQuestions(); else await loadMsgs();
      if (tab === 'alerts') { const d = await j('/api/admin/outbox'); $('#smswarn').hidden = d.sms.live; }
    } catch (e) { $('#err').textContent = e.message; $('#err').hidden = false; }
  }

  function setTab(t) {
    tab = t;
    $('#tab-alerts').setAttribute('aria-pressed', t === 'alerts');
    $('#tab-msgs').setAttribute('aria-pressed', t === 'msgs');
    $('#tab-transport').setAttribute('aria-pressed', t === 'transport');
    $('#tab-questions').setAttribute('aria-pressed', t === 'questions');
    $('#questions').hidden = t !== 'questions';
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

  refresh();
  setInterval(refresh, 8000);
})();

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
        <div class="meta">Via ${esc(a.channel)} · ${esc(a.facility_name || 'no facility')}${a.lat != null ? ` · <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=16/${a.lat}/${a.lng}">her location</a>` : ' · no GPS'}${a.contact_phone ? ` · contact ${esc(a.contact_phone)}` : ''}</div>
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

  async function refresh() {
    try {
      $('#err').hidden = true;
      if (tab === 'alerts') await loadAlerts(); else await loadMsgs();
      if (tab === 'alerts') { const d = await j('/api/admin/outbox'); $('#smswarn').hidden = d.sms.live; }
    } catch (e) { $('#err').textContent = e.message; $('#err').hidden = false; }
  }

  function setTab(t) {
    tab = t;
    $('#tab-alerts').setAttribute('aria-pressed', t === 'alerts');
    $('#tab-msgs').setAttribute('aria-pressed', t === 'msgs');
    $('#alerts').hidden = t !== 'alerts';
    $('#msgs').hidden = t !== 'msgs';
    refresh();
  }

  $('#tab-alerts').onclick = () => setTab('alerts');
  $('#tab-msgs').onclick = () => setTab('msgs');
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

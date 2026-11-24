(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { const v = localStorage.getItem(k); if (v) return v; } catch { /* try tab storage */ } try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); try { sessionStorage.removeItem(k); } catch { /* storage unavailable */ } } catch { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } try { sessionStorage.removeItem(k); } catch { /* storage unavailable */ } }
  };

  const main = $('#main'), nav = $('#nav'), notice = $('#notice');
  let cfg = { ussdCode: '', smsNumber: '', emergencyNumber: '999', helplines: [] };
  let token = store.get('ms_token');
  let me = null;
  let pos = null;
  let mapHandle = null;
  let care = { q: '', kind: '', ownership: '', open24: false, limit: 20, mode: 'hospitals', sel: null, sheet: 'half', pick: false };
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
  // New users can register; returning users with a saved valid token go straight to Home.
  let authMode = 'login';
  let recoveryCodeToShow = '';
  let recoveryNext = 'login';
  let authPrefill = '';
  let authStep = '';
  let authDraft = {};

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.error || (res.status === 404 && path.startsWith('/api/account/')
        ? 'Password sign-in is not enabled on this server yet. Restart or redeploy MamaSafe, then refresh the page.'
        : 'Something went wrong.');
      const e = new Error(message);
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
  const facilityLabel = (f) => f && f.kind === 'health_centre' && f.ownership === 'government' ? 'Government health centre' : KIND[f && f.kind] || 'Facility';
  const bestPhone = (f) => f && (f.phone || f.emergency_phone || f.toll_free);

  // Every number we hold, each one a tap-to-call button. Nothing is invented: no number, no button.
  function contactHtml(f) {
    const b = [];
    if (f.phone) b.push(`<a class="btn" href="${telHref(f.phone)}">Call ${esc(fmtPhone(f.phone))}</a>`);
    if (f.emergency_phone) b.push(`<a class="btn emerg" href="${telHref(f.emergency_phone)}">Emergency ${esc(fmtPhone(f.emergency_phone))}</a>`);
    if (f.toll_free) b.push(`<a class="btn tf" href="${telHref(f.toll_free)}">Toll-free ${esc(fmtPhone(f.toll_free))}</a>`);
    let html = b.length ? `<div class="row">${b.join('')}</div>` : `<p class="muted warn nophone">No phone on file. In an emergency, call ${esc(cfg.emergencyNumber)}.</p>`;
    if (b.length && f.contact_confidence === 'low') html += '<p class="muted warn">This number comes from an older or unofficial source and may have changed.</p>';
    return html;
  }

  function say(msg, isError) {
    notice.hidden = !msg;
    notice.textContent = msg || '';
    notice.className = isError ? 'error' : '';
  }

  function locate(timeout = 15000) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, capturedAt: p.timestamp }),
        () => resolve(null),
        // A user explicitly asked for their location: don't silently reuse an old cached fix.
        { enableHighAccuracy: true, timeout, maximumAge: 0 }
      );
    });
  }

  const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const isoToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

  function show(html, keep) {
    if (mapHandle) { mapHandle.destroy(); mapHandle = null; }
    main.classList.remove('mapmode'); document.body.classList.remove('mapmode');
    main.innerHTML = html;
    if (keep) return;
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function setNav() {
    nav.hidden = !(me && me.registered);
    const db_ = $('#demobar'); if (db_) db_.hidden = !(me && me.demo);
    nav.querySelectorAll('button').forEach((b) => {
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  function signOut() {
    token = null; me = null; authMode = 'login'; authStep = ''; authDraft = {};
    store.del('ms_token');
    go('auth');
  }

  async function go(v) {
    // The old 'ambulance' booking screen is now the Ambulance tab of the map screen.
    if (v === 'ambulance') { care.mode = 'ambulance'; v = 'care'; }
    view = v;
    say('');
    setNav();
    main.classList.add('enter'); setTimeout(() => main.classList.remove('enter'), 400);
    try {
      if (v === 'auth') return renderAuth();
      if (v === 'tour') return renderTour(0);
      if (v === 'guide') return renderGuide();
      if (v === 'register') return await renderRegister();
      if (v === 'contact') return renderContactSetup();
      if (v === 'home') return renderHome();
      if (v === 'visits') return renderVisits();
      if (v === 'sos') return renderSos();
      if (v === 'bag') return renderBag();
      if (v === 'chat') return renderChat();
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
    if (authMode === 'recovery-code') {
      show(`<div class="card recovery-card"><h1>Save your recovery code</h1>
        <p class="muted">Keep this code somewhere private. If you forget your password, use it to reset it. It can only be used once; we’ll give you a new one after recovery.</p>
        <p class="recovery-code" id="recoveryCode">${esc(recoveryCodeToShow)}</p>
        <button class="ghost full" id="copyRecovery" type="button">Copy recovery code</button>
        <button class="full" id="savedRecovery" type="button">Continue</button></div>`);
      $('#copyRecovery').onclick = async () => {
        try { await navigator.clipboard.writeText(recoveryCodeToShow); say('Recovery code copied.'); }
        catch { say('Copy is unavailable here. Please copy the code above.', true); }
      };
      $('#savedRecovery').onclick = async () => {
        const next = recoveryNext; recoveryCodeToShow = '';
        if (next === 'profile' || next === 'home') {
          try {
            await loadMe();
            go(me.registered ? 'home' : (next === 'profile' ? 'register' : 'home'));
          }
          catch (err) { say(err.message, true); }
        } else { authMode = 'login'; renderAuth(); say('Password updated. Sign in with your new password.'); }
      };
      return;
    }

    const registering = authMode === 'register';
    const otpMode = authMode === 'otp';
    const loggingIn = authMode === 'login';
    const recovering = authMode === 'recover';
    const codeStep = authStep === 'code' && (registering || otpMode);
    const demoCode = !!authDraft.demo;
    const title = registering ? (codeStep ? 'Check your messages' : 'Create your account') : otpMode ? (codeStep ? 'Check your messages' : 'Sign in with a code') : recovering ? 'Reset your password' : 'Welcome back';
    const sub = registering ? (codeStep ? (demoCode ? 'Enter your demo access code to create this account.' : `We sent a 6-digit code to ${esc(authDraft.phone)}.`) : 'Takes about a minute. We will text you a code to confirm your number.')
      : otpMode ? (codeStep ? (demoCode ? 'Enter your demo access code to sign in.' : `We sent a 6-digit code to ${esc(authDraft.phone)}.`) : 'No password needed. We text a code to your phone.')
      : recovering ? 'Use your recovery code to continue.' : 'Sign in to continue your care.';
    const submitText = registering ? (codeStep ? 'Create my account' : 'Send me a code') : otpMode ? (codeStep ? 'Sign in' : 'Send me a code') : recovering ? 'Reset password' : 'Sign in';
    const codeField = `<label for="code" style="margin-top:0">${demoCode ? 'Demo access code' : '6-digit code'}</label>
          <input id="code" type="text" ${demoCode ? 'autocomplete="off" maxlength="128" placeholder="Enter the demo access code"' : 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"'} required>
          <p class="muted auth-note" style="margin:6px 0 0">${demoCode ? 'Enter the demo access code provided to you.' : 'The code expires in 10 minutes.'} <button class="link" id="resendCode" type="button">${demoCode ? 'Check access code' : 'Send a new code'}</button> · <button class="link" id="changeNumber" type="button">Use a different number</button></p>`;
    const fields = registering
      ? (codeStep ? codeField : `<label for="phone" style="margin-top:0">Phone number <span class="muted">(required)</span></label>
          <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0712 345 678" value="${esc(authDraft.phone || '')}" required>
          <label for="email">Email <span class="muted">(optional)</span></label>
          <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${esc(authDraft.email || '')}">
          <label for="password">Create a password <span class="muted">(at least 8 characters)</span></label><input id="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
          <label for="confirm">Confirm password</label><input id="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>`)
      : otpMode
        ? (codeStep ? codeField : `<label for="phone" style="margin-top:0">Phone number</label>
          <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0712 345 678" value="${esc(authDraft.phone || authPrefill || '')}" required>`)
        : `<label for="identifier" style="margin-top:0">Phone number or email</label>
          <input id="identifier" type="text" autocomplete="username" placeholder="Phone number or email" value="${esc(authPrefill)}" required>
          ${recovering ? `<label for="recovery">Recovery code</label><input id="recovery" type="text" autocomplete="off" autocapitalize="characters" required>
            <label for="password">New password</label><input id="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
            <label for="confirm">Confirm new password</label><input id="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>`
            : `<label for="password">Password</label><input id="password" type="password" autocomplete="current-password" maxlength="128" required>`}`;
    show(`<section class="auth-screen">
      <div class="auth-hero">
        <p class="eyebrow">MAMASAFE · YOUR PREGNANCY COMPANION</p>
        <h1>Pregnancy care<br><span>for every step.</span></h1>
        <p class="auth-tagline">Appointments, wellbeing checks and support for the journey ahead.</p>
        <div class="auth-art" aria-hidden="true">
          <span class="auth-orbit"></span><span class="auth-orbit inner"></span>
          <svg class="baby-art" viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="womb" x1="70" y1="42" x2="230" y2="262" gradientUnits="userSpaceOnUse"><stop stop-color="#FFD8B8"/><stop offset="1" stop-color="#EF9575"/></linearGradient><linearGradient id="baby" x1="110" y1="86" x2="212" y2="236" gradientUnits="userSpaceOnUse"><stop stop-color="#FFE4C9"/><stop offset="1" stop-color="#F6AD88"/></linearGradient></defs>
            <path d="M151 38c-61 0-108 47-108 108 0 59 46 111 110 111 31 0 56-12 78-35-22 8-47 3-59-15-11-16-7-33 6-49 14-18 23-36 19-60-5-34-24-60-46-60Z" fill="url(#womb)" opacity=".64"/>
            <path d="M119 112c8-24 37-34 59-22 19 11 25 31 18 49-5 12-16 21-29 23-8 2-14 7-17 14-5 12 4 24 17 32 11 7 25 10 38 10-12 19-34 30-59 27-32-4-55-29-54-58 0-16 9-28 24-36 11-6 19-12 22-22 3-9-4-19-15-17-4 1-7 3-10 7-4 6-8 5-10-1-2-2-1-4 0-6l16 0Z" fill="url(#baby)"/>
            <path d="M163 116c3 0 5 2 5 5s-2 5-5 5-5-2-5-5 2-5 5-5Z" fill="#9B4C3B" opacity=".7"/>
            <path d="M139 155c12 8 27 9 40 4M145 188c9 9 19 13 31 14" stroke="#E58A6F" stroke-width="7" stroke-linecap="round" opacity=".65"/>
            <path d="M52 207c38-5 58 12 82 27 20 12 40 19 65 15" stroke="#FFF7E9" stroke-width="12" stroke-linecap="round" opacity=".8"/>
            <circle cx="80" cy="87" r="7" fill="#FFF7E9" opacity=".8"/><circle cx="224" cy="98" r="5" fill="#FFF7E9" opacity=".75"/>
          </svg>
        </div>
      </div>
      <div class="auth-content">
      <div class="auth-heading"><span class="eyebrow">MAMASAFE</span><h2>${title}</h2><p class="muted">${sub}</p></div>
      <div class="auth-tabs" role="tablist" aria-label="Account action">
        <button type="button" data-auth="register" aria-selected="${registering}">Create account</button>
        <button type="button" data-auth="login" aria-selected="${loggingIn || otpMode || recovering}">Sign in</button>
      </div>
      <form id="accountForm" class="card auth-form">
        ${fields}
        <button class="full" type="submit">${submitText}</button>
        ${registering && !codeStep ? '<p class="muted auth-note">After signup you will get a recovery code. Save it so you can reset your password without SMS.</p>' : ''}
      </form>
      ${loggingIn ? '<button class="link full" id="otpLink" type="button">Sign in with a text-message code instead</button><button class="link full" id="forgotPassword" type="button">Forgot your password?</button>' : (recovering || otpMode) ? '<button class="link full" id="backToLogin" type="button">Back to sign in</button>' : ''}
      </div></section>`);
    const resetStep = () => { authStep = ''; };
    document.querySelectorAll('[data-auth]').forEach((b) => { b.onclick = () => { authMode = b.dataset.auth; resetStep(); authDraft = {}; renderAuth(); }; });
    if ($('#forgotPassword')) $('#forgotPassword').onclick = () => { authMode = 'recover'; resetStep(); renderAuth(); };
    if ($('#otpLink')) $('#otpLink').onclick = () => { authMode = 'otp'; resetStep(); authDraft = { phone: $('#identifier').value.includes('@') ? '' : $('#identifier').value }; renderAuth(); };
    if ($('#backToLogin')) $('#backToLogin').onclick = () => { authMode = 'login'; resetStep(); renderAuth(); };
    if ($('#changeNumber')) $('#changeNumber').onclick = () => { resetStep(); renderAuth(); };
    // Ask the server to text a code. In development the code is shown on screen instead.
    const sendCode = async (phone) => {
      const r = await api('/api/otp/request', { method: 'POST', body: { phone } });
      authDraft.phone = r.phone || phone;
      authDraft.demo = !!r.demo;
      return {
        verificationSkipped: !!r.verificationSkipped,
        message: r.demo ? 'Enter the demo access code provided to you.' : r.devCode ? `Development code: ${r.devCode}` : ''
      };
    };
    if ($('#resendCode')) $('#resendCode').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try { const sent = await sendCode(authDraft.phone); say(sent.message || 'A new code is on its way.'); }
      catch (err) { say(err.message, true); }
      finally { if ($('#resendCode')) $('#resendCode').disabled = false; }
    };
    const finishRegistration = async (code) => {
      const r = await api('/api/account/register', { method: 'POST', body: { phone: authDraft.phone, email: authDraft.email, password: authDraft.password, ...(code ? { code } : {}) } });
      token = r.token; store.set('ms_token', token);
      recoveryCodeToShow = r.recoveryCode; recoveryNext = 'profile'; authMode = 'recovery-code'; authStep = ''; authDraft = {}; renderAuth();
    };
    $('#accountForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#accountForm button[type=submit]');
      if (((registering && !codeStep) || recovering) && $('#password').value !== $('#confirm').value) return say('Those passwords do not match.', true);
      btn.disabled = true;
      try {
        if (registering && !codeStep) {
          authDraft = { phone: $('#phone').value.trim(), email: $('#email').value.trim(), password: $('#password').value };
          const sent = await sendCode(authDraft.phone);
          if (sent.verificationSkipped) {
            await finishRegistration();
            return;
          }
          authStep = 'code'; renderAuth(); say(sent.message || 'We sent you a code. Enter it below.');
          return;
        }
        if (otpMode && !codeStep) {
          const sent = await sendCode($('#phone').value.trim());
          if (sent.verificationSkipped) {
            authPrefill = authDraft.phone;
            authMode = 'register'; authStep = ''; authDraft = { phone: authPrefill };
            renderAuth(); say('Text-message sign-in is unavailable. Create a password account to continue.');
          } else {
            authStep = 'code'; renderAuth(); say(sent.message || 'We sent you a code. Enter it below.');
          }
          return;
        }
        if (otpMode) {
          const r = await api('/api/otp/verify', { method: 'POST', body: { phone: authDraft.phone, code: $('#code').value } });
          token = r.token; store.set('ms_token', token); authStep = ''; authDraft = {};
          await loadMe(); go(me.registered ? 'home' : 'register');
          return;
        }
        if (registering) {
          await finishRegistration($('#code').value);
          return;
        }
        const r = recovering
            ? await api('/api/account/recover', { method: 'POST', body: { identifier: $('#identifier').value, recoveryCode: $('#recovery').value, password: $('#password').value } })
            : await api('/api/account/login', { method: 'POST', body: { identifier: $('#identifier').value, password: $('#password').value } });
        if (recovering) {
          recoveryCodeToShow = r.recoveryCode; recoveryNext = 'login'; authMode = 'recovery-code'; renderAuth();
        } else {
          token = r.token; store.set('ms_token', token);
          await loadMe(); go(me.registered ? 'home' : 'register');
        }
      } catch (err) {
        if (registering && err.status === 409 && /An account already uses this (phone|email)/.test(err.message)) {
          authPrefill = err.message.includes('email') ? authDraft.email : authDraft.phone;
          authMode = 'login'; authStep = ''; renderAuth();
          say('An account already exists. Sign in with its phone or email and password.');
          return;
        }
        say(err.message, true); btn.disabled = false;
      }
    };
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
    show(`<p class="eyebrow">Set up your profile · step 2 of 2</p><h1>Set up your care</h1>
        <p class="muted">A few details to set up your care.</p>
      <form id="f">
        <label for="name">Full name</label>
        <input id="name" type="text" autocomplete="name" maxlength="80" placeholder="e.g. Amina Nansubuga" required>
        <p class="muted" style="margin:-2px 0 8px">Enter your first and family names.</p>
        <label for="lmp">First day of your last period</label>
        <input id="lmp" type="date" min="${isoDaysAgo(280)}" max="${isoToday()}" required>
        <label for="fsearch">Your clinic or hospital</label>
        <input id="fsearch" type="search" placeholder="Type a district or the clinic's name" autocomplete="off">
        <button class="ghost" type="button" id="loc" style="margin-top:10px">${pos ? 'Location shared ✓' : 'Share my location'}</button>
        <p id="locnote" class="muted location-note">Share a one-time location to add a location record to your registration and find nearby care. You can continue without it.</p>
        <div id="fres" class="pick" role="radiogroup" aria-label="Choose your facility"></div>
      <label for="contact">Emergency contact phone number <span class="muted">(recommended)</span></label>
        <input id="contact" type="tel" inputmode="tel" autocomplete="off" placeholder="0772 123 456">
        <p class="muted" style="margin:-2px 0 8px">Someone we can text if you send an SOS. You can skip this now and add it later. We will remind you on Home.</p>
        <label class="check"><input id="sms" type="checkbox" checked> Send visit reminders by SMS (when available)</label>
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
          <span><b>${esc(f.name)}</b><br><span class="muted">${esc(facilityLabel(f))} · ${esc(f.area)}${f.distanceKm != null ? ' · ' + f.distanceKm + ' km' : ''}</span></span></label>`).join('')
          + (total > facilities.length ? `<p class="muted">${total - facilities.length} more. Type to narrow the list.</p>` : '') || '<p class="muted">Nothing found. Try the district name.</p>';
      } catch (err) { say(err.message, true); }
    };
    let timer = null;
    $('#fsearch').oninput = () => { clearTimeout(timer); timer = setTimeout(list, 250); };
    $('#fres').onchange = (e) => { chosen = Number(e.target.value); };
    $('#loc').onclick = async () => {
      say('Requesting your location…');
      pos = await locate(12000);
      if (pos) {
        say('Location shared for registration.');
        $('#loc').textContent = 'Location shared ✓';
        $('#locnote').textContent = 'A one-time location record will be saved with your registration. It can also help find nearby care.';
        list();
      } else {
        say('Location wasn’t available. You can search by district and continue without sharing it.', true);
      }
    };
    list();
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#f button[type=submit]'); btn.disabled = true;
      try {
        me = await api('/api/register', { method: 'POST', body: { name: $('#name').value, lmp: $('#lmp').value, facilityId: chosen, contactPhone: $('#contact').value.trim() || undefined, smsOptin: $('#sms').checked, location: pos } });
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

  // ---------- Ask MamaSafe ----------
  let chatLog = [];
  function renderChat() {
    const fac = me.facility && bestPhone(me.facility);
    const act = (a, i) => {
      if (a === 'sos') return '<button type="button" class="danger" data-act="sos">Press SOS</button>';
      if (a === 'care') return '<button type="button" class="ghost" data-act="care">Find a hospital</button>';
      if (a === 'call') return `<a class="btn ghost" href="${telHref(fac || cfg.emergencyNumber)}">Call ${fac ? 'my clinic' : esc(cfg.emergencyNumber)}</a>`;
      if (a === 'check') return '<button type="button" class="ghost" data-act="check">Check my symptoms</button>';
      if (a === 'bag') return '<button type="button" class="ghost" data-act="bag">Hospital bag list</button>';
      if (a === 'visits') return '<button type="button" class="ghost" data-act="visits">My visits</button>';
      if (a === 'home') return '<button type="button" class="ghost" data-act="home">Go to Home</button>';
      if (a === 'escalate') return `<button type="button" data-act="escalate" data-i="${i}">Send to my clinic</button>`;
      if (a === 'retry') return `<button type="button" class="ghost" data-act="retry" data-i="${i}">Try again</button>`;
      return '';
    };
    const bubble = (m, i) => m.role === 'me'
      ? `<div class="bub me">${esc(m.text)}</div>`
      : (() => {
        const btns = (m.acts || []).map((a) => act(a, i)).join('') + (m.kind === 'answer' && m.title && !(m.acts || []).includes('escalate') ? `<button type="button" class="link" data-act="escalate" data-i="${i}">Not what I asked? Send to my clinic</button>` : '');
        return `<div class="bub bot ${m.kind || ''}">${m.title ? `<small>${esc(m.title)}</small>` : ''}<div>${esc(m.text)}</div>${btns ? `<div class="acts">${btns}</div>` : ''}</div>`;
      })();
    const draw = () => {
      const el = $('#chatlog'); if (!el) return;
      el.innerHTML = chatLog.map(bubble).join('');
      el.scrollTop = el.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    };
    show(`<div class="chat"><button type="button" class="link back" id="cback">← Home</button><h1>Ask MamaSafe</h1>
      <p class="muted" style="margin:0 0 8px">An automated helper with reviewed answers. It is not a doctor and cannot diagnose. In an emergency press SOS or call ${esc(cfg.emergencyNumber)}.</p>
      <div id="chatlog" class="chatlog" aria-live="polite"></div>
      <div id="chips" class="chips"></div>
      <form id="cf" class="chatform"><label for="cq" class="sr">Your question</label><input id="cq" type="text" maxlength="300" autocomplete="off" placeholder="Type your question"><button type="submit" aria-label="Send">${svg('<path d="M4 12 20 4l-4 16-4-7z"/>')}</button></form></div>`);
    if (!chatLog.length) chatLog.push({ role: 'bot', kind: 'answer', text: `Hello${me.mother.name ? ' ' + me.mother.name : ''}. Ask me about your visits, food, tablets, common discomforts, or what to do in an emergency.`, acts: [] });
    draw();
    $('#cback').onclick = () => go('home');
    api('/api/chat/suggestions').then((d) => { if (chatLog.length < 3 && $('#chips')) { $('#chips').innerHTML = d.suggestions.map((t) => `<button type="button" class="chip">${esc(t)}</button>`).join(''); } }).catch(() => {});
    const ask = async (text) => {
      text = text.trim(); if (!text) return;
      const input = $('#cq'), form = $('#cf'), chips = $('#chips');
      chatLog.push({ role: 'me', text }); draw();
      if (input) input.value = '';
      if (chips) chips.innerHTML = '';
      if (input) input.disabled = true;
      if (form) form.querySelector('button').disabled = true;
      chatLog.push({ role: 'bot', kind: 'pending', text: 'One moment, I’m checking that for you…', pending: true }); draw();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const r = await api('/api/chat', { method: 'POST', body: { text }, signal: controller.signal });
        chatLog = chatLog.filter((m) => !m.pending);
        chatLog.push({ role: 'bot', kind: r.kind, title: r.title, text: r.text, acts: r.acts, asked: text });
      } catch (e) {
        chatLog = chatLog.filter((m) => !m.pending);
        if (e.status === 401) return signOut();
        chatLog.push({ role: 'bot', kind: 'unknown', text: (e.name === 'AbortError' ? 'That is taking longer than expected.' : 'I could not reach MamaSafe just now.') + ' If this is urgent, press SOS or call ' + cfg.emergencyNumber + '. Otherwise, please try again.', acts: ['retry', 'sos', 'call'], asked: text });
      } finally {
        clearTimeout(timeout);
        if (input) input.disabled = false;
        if (form && form.querySelector('button')) form.querySelector('button').disabled = false;
      }
      draw();
    };
    $('#cf').onsubmit = (e) => { e.preventDefault(); ask($('#cq').value); };
    $('#chips').onclick = (e) => { if (e.target.classList.contains('chip')) ask(e.target.textContent); };
    $('#chatlog').onclick = async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'sos') return go('sos');
      if (a === 'retry') { const m = chatLog[Number(b.dataset.i)]; if (m && m.asked) ask(m.asked); return; }
      if (a === 'check' || a === 'bag' || a === 'visits' || a === 'home' || a === 'care') return go(a);
      if (a === 'escalate') {
        const m = chatLog[Number(b.dataset.i)]; const q = (m && m.asked) || '';
        b.disabled = true;
        try {
          const r = await api('/api/chat/escalate', { method: 'POST', body: { text: q } });
          const callLine = r.facility && r.facility.phone ? ` You can also call ${fmtPhone(r.facility.phone)}.` : '';
          chatLog.push({ role: 'bot', kind: 'answer', acts: [], text: r.demo ? 'Demo mode: your question was not sent to any clinic.'
            : r.notified ? `Your question was sent to ${r.facility ? r.facility.name : 'your clinic'}. A health worker should get back to you.${callLine}`
              : `I saved your question, but I could not text your clinic.${callLine || ' Please call your clinic.'}` });
        } catch (err) { say(err.message, true); b.disabled = false; return; }
        draw();
      }
    };
  }

  // ---------- baby size, kick counter, hospital bag ----------
  // Rough, widely used size comparisons (emoji chosen to show on older Android phones). Not medical measurements.
  const BABY = [[8, '🍇', 'a grape', 1.6], [10, '🍓', 'a strawberry', 3.1], [12, '🍋', 'a lime', 5.4], [14, '🍋', 'a lemon', 8.7], [16, '🥑', 'an avocado', 11.6],
    [18, '🍠', 'a sweet potato', 14], [20, '🍌', 'a banana', 25], [22, '🌽', 'a corn cob', 28], [24, '🥒', 'a cucumber', 30], [26, '🥦', 'a head of broccoli', 35],
    [28, '🍆', 'an aubergine', 37], [30, '🍈', 'a small melon', 40], [32, '🍍', 'a pineapple', 42], [34, '🍈', 'a cantaloupe', 45], [36, '🍉', 'a small watermelon', 47],
    [38, '🍉', 'a watermelon', 50], [40, '🍉', 'a watermelon', 51]];
  function babySize(w) {
    if (w < 8) return { emoji: '🌱', name: 'a tiny bean', cm: null };
    let r = BABY[0];
    for (const b of BABY) if (w >= b[0]) r = b;
    return { emoji: r[1], name: r[2], cm: r[3] };
  }
  function babyCard(weeks) {
    const b = babySize(weeks);
    return `<div class="card baby"><div class="fruit" aria-hidden="true">${b.emoji}</div>
      <div><h3>Your baby this week</h3><div class="when">About the size of ${b.name}</div>
      ${b.cm ? `<div class="muted">Around ${b.cm} cm long. Every baby is different.</div>` : '<div class="muted">Everything is just starting to form.</div>'}</div></div>`;
  }

  const BAG = [
    ['For papers and money', [['card', 'Antenatal card and any test results'], ['id', 'Your ID and the number of your emergency contact, written down'], ['money', 'Money for transport and small costs'], ['phone', 'Phone and charger']]],
    ['For you', [['kanga', 'Two clean kangas or lesus'], ['pads', 'Sanitary pads'], ['soap', 'Soap and a towel'], ['clothes', 'Change of clothes and warm wrap'], ['water', 'Water and a snack']]],
    ['For baby', [['wrap', 'Soft blanket or wrap'], ['bclothes', 'Baby clothes, a hat and socks'], ['cloths', 'Clean soft cloths']]]
  ];
  function renderBag() {
    const load = () => { try { return JSON.parse(store.get('ms_bag') || '{}'); } catch { return {}; } };
    const total = BAG.reduce((a, g) => a + g[1].length, 0);
    const paint = () => {
      const got = load(), have = Object.keys(got).filter((k) => got[k]).length;
      show(`<button type="button" class="link back" id="bback">← Back</button>
        <h1>Hospital bag</h1>
        <p class="muted">Pack by week 34 so you are ready if baby comes early. Ask your clinic if they want anything else.</p>
        <div class="meter dark" aria-hidden="true"><span style="width:${Math.round((have / total) * 100)}%"></span></div>
        <p class="muted"><b>${have} of ${total}</b> packed</p>
        ${BAG.map(([title, items]) => `<div class="card"><h3 style="margin:0 0 6px">${title}</h3>${items.map(([id, label]) => `<label class="check"><input type="checkbox" data-bag="${id}" ${got[id] ? 'checked' : ''}> ${label}</label>`).join('')}</div>`).join('')}
        <div class="card"><h3 style="margin:0 0 4px">Bag ready? What next</h3><p class="muted" style="margin:0 0 10px">Three things that make a big difference on the day.</p>
        <button type="button" class="ghost full" data-next="home">Save and confirm your emergency contact</button>
        <button type="button" class="ghost full" data-next="care" style="margin-top:8px">Find your hospital and its phone number</button>
        <button type="button" class="ghost full" data-next="chat" style="margin-top:8px">Ask MamaSafe a question</button></div>`);
      document.querySelectorAll('[data-next]').forEach((b) => { b.onclick = () => go(b.dataset.next); });
      $('#bback').onclick = () => go('home');
      document.querySelectorAll('[data-bag]').forEach((c) => { c.onchange = () => { const g = load(); g[c.dataset.bag] = c.checked; store.set('ms_bag', JSON.stringify(g)); const h = Object.keys(g).filter((k) => g[k]).length; document.querySelector('.meter span').style.width = Math.round((h / total) * 100) + '%'; document.querySelector('.meter + p b').textContent = h + ' of ' + total; }; });
    };
    paint();
  }

  // ---------- home ----------
  function homeRing(pct, tri, weeks) {
    const R = 82, C = 2 * Math.PI * R, a = (pct / 100) * 2 * Math.PI - Math.PI / 2;
    const kx = 100 + R * Math.cos(a), ky = 100 + R * Math.sin(a);
    return `<div class="ring" role="img" aria-label="Week ${weeks} of 40, ${pct} percent of pregnancy">
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d58b70"/><stop offset="1" stop-color="#a34d38"/></linearGradient></defs>
        <circle cx="100" cy="100" r="96" fill="#fff" opacity=".7"/>
        <circle cx="100" cy="100" r="${R}" fill="none" stroke="#f4d2bd" stroke-width="16"/>
        <circle cx="100" cy="100" r="${R}" fill="none" stroke="url(#rg)" stroke-width="16" stroke-linecap="round" stroke-dasharray="${(C * pct / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 100 100)"/>
        <circle cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="11" fill="#fff" stroke="#a34d38" stroke-width="4"/>
      </svg>
      <div class="mid"><small>You are in your</small><div class="stage">${tri}</div><small>Pregnancy</small><div class="big">Week ${weeks}</div></div></div>`;
  }

  function weekStrip(nextDate) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    let out = '';
    for (let k = 0; k < 7; k++) {
      const d = new Date(mon); d.setDate(mon.getDate() + k);
      const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const cls = (d.getTime() === now.getTime() ? ' today' : '') + (nextDate && String(nextDate).slice(0, 10) === iso ? ' visit' : '');
      out += `<div class="day${cls}"><span>${names[d.getDay()]}</span><b>${d.getDate()}</b></div>`;
    }
    return `<div class="week" aria-label="This week">${out}</div>`;
  }

  // The emergency contact never blocks sign-up. Until it is added and confirmed, Home keeps reminding her.
  function contactReminder() {
    const m = me && me.mother; if (!m || m.contactVerified) return '';
    return m.contactPhone
      ? `<div class="remind" role="status"><span class="ico">${svg(ICON.shield)}</span><div><b>Confirm your emergency contact</b><p>We texted ${esc(fmtPhone(m.contactPhone))}. Ask them for the 6-digit code and enter it.</p></div><button type="button" data-go="contact">Confirm now</button></div>`
      : `<div class="remind" role="status"><span class="ico">${svg(ICON.shield)}</span><div><b>Add an emergency contact</b><p>Choose someone we can text if you ever send an SOS. It takes one minute.</p></div><button type="button" data-go="contact">Add now</button></div>`;
  }
  function contactStatusCard() {
    const m = me && me.mother; if (!m || !m.contactVerified) return '';
    return `<div class="card contactrow"><div><b>Emergency contact</b><div class="muted">${esc(fmtPhone(m.contactPhone))} · confirmed ✓</div></div><button type="button" class="ghost" data-go="contact">Change</button></div>`;
  }

  function renderHome() {
    const g = me.gestation, pct = Math.min(100, Math.round((g.totalDays / 280) * 100));
    const next = me.next;
    const tri = g.weeks < 13 ? 'First trimester' : g.weeks < 28 ? 'Second trimester' : 'Third trimester';
    const left = Math.max(0, 40 - g.weeks);
    const hr = new Date().getHours();
    const hello = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const done = (me.visits || []).filter((v) => v.status === 'past').length;
    const days = g.days != null ? g.days : g.totalDays % 7;
    const fac = me.facility;
    const firstName = String(me.mother.name || '').trim().split(/\s+/)[0];
    show(`<div class="greet"><div><h1>${hello}${firstName ? ', ' + esc(firstName) : ''}</h1><p>It's week ${g.weeks}, day ${days + 1}</p></div>
        <button type="button" class="cal-btn" data-go="visits" aria-label="My 8 visits">${svg(ICON.calendar)}</button></div>
      ${contactReminder()}
      ${weekStrip(next && next.date)}
      ${homeRing(pct, tri, g.weeks)}
      <div class="bubbles">
        <div class="bubble"><small>Due</small><b>${esc(new Date(me.edd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</b></div>
        <div class="bubble"><small>To go</small><b>${left} ${left === 1 ? 'week' : 'weeks'}</b></div>
        <div class="bubble"><small>Visits done</small><b>${done} of 8</b></div>
      </div>
      <button type="button" class="askcard" data-go="chat"><span class="ico">${svg(ICON.chat)}</span><span><b>Ask MamaSafe</b><small>Questions about your pregnancy? Get an answer, or send it to your clinic.</small></span></button>
      ${babyCard(g.weeks)}
      <div class="rail">
        <div class="tile fill">${next
          ? `<h3>Next visit ${next.no} of 8</h3><div class="when">${fmtDate(next.date)}</div><div>${fac ? esc(fac.name) : 'No facility chosen yet'}</div><div class="meter" aria-hidden="true"><span style="width:${Math.round((next.no / 8) * 100)}%"></span></div>${fac && bestPhone(fac) ? `<a class="btn light" href="${telHref(bestPhone(fac))}">Call ${esc(fmtPhone(bestPhone(fac)))}</a>` : ''}`
          : '<h3>No more visits planned</h3><div>Your baby is due soon. Text or tap SOS if you need urgent help.</div>'}</div>
        <div class="tile soft"><h3>Know the danger signs</h3><div>Heavy bleeding, fits, severe headache with blurred vision, or baby moving much less: go to a health facility straight away and press SOS.</div></div>
      </div>
      <div class="quick">
        <button type="button" data-go="check"><span class="ico">${svg(ICON.pulse)}</span>Check my symptoms<small>Not feeling right?</small></button>
        <button type="button" data-go="care"><span class="ico">${svg(ICON.pin)}</span>Find a hospital<small>Nearest, with phone numbers</small></button>
        <button type="button" data-go="ambulance"><span class="ico">${svg(ICON.alert)}</span>Ambulance service<small>Find and call an available ambulance</small></button>
        <button type="button" data-go="visits"><span class="ico">${svg(ICON.calendar)}</span>My 8 visits<small>Dates and reminders</small></button>
        <button type="button" data-go="bag"><span class="ico">${svg(ICON.shield)}</span>Hospital bag<small>A checklist to pack</small></button>
        <button type="button" data-go="guide"><span class="ico">${svg(ICON.book)}</span>User guide<small>How MamaSafe works</small></button>
      </div>
      ${payCard()}
      ${basicPhoneCard()}
      ${me.account && me.account.passwordSet && me.account.recoverySet ? '' : `<details class="card fold"><summary><span><b>Set up account recovery</b><small>Add a password so you can always get back in</small></span></summary>
        <form id="passwordSetup" class="foldbody"><p class="muted" style="margin-top:0">Choose a password and save a recovery code. The code lets you reset your password without SMS.</p>
          <label for="accountEmail">Email <span class="muted">(optional)</span></label><input id="accountEmail" type="email" autocomplete="email">
          <label for="accountPassword">New password</label><input id="accountPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required>
          <label for="accountConfirm">Confirm password</label><input id="accountConfirm" type="password" minlength="8" maxlength="128" autocomplete="new-password" required>
          <button class="full" type="submit">Save password and recovery code</button></form></details>`}
      ${contactStatusCard()}
      <div class="card account-actions"><button class="ghost full" id="out" type="button">Sign out</button></div>`);
    wirePay();
    document.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => (b.dataset.go === 'guide' ? openGuide() : go(b.dataset.go)); });
    $('#out').onclick = signOut;
    const passwordSetup = $('#passwordSetup');
    if (passwordSetup) passwordSetup.onsubmit = async (e) => {
      e.preventDefault();
      if ($('#accountPassword').value !== $('#accountConfirm').value) return say('Those passwords do not match.', true);
      const btn = $('#passwordSetup button[type=submit]'); btn.disabled = true;
      try {
        const email = $('#accountEmail').value.trim();
        const r = await api('/api/account/password', { method: 'POST', body: { ...(email ? { email } : {}), password: $('#accountPassword').value } });
        recoveryCodeToShow = r.recoveryCode; recoveryNext = 'home'; authMode = 'recovery-code'; renderAuth();
      } catch (err) { say(err.message, true); btn.disabled = false; }
    };
  }

  // Adding and confirming the emergency contact. Optional: she can leave at any time and finish later.
  function renderContactSetup() {
    const currentPhone = me && me.mother && me.mother.contactPhone ? fmtPhone(me.mother.contactPhone) : '';
    show(`<button type="button" class="link back" id="contactBack">← Home</button><h1>${me && me.mother && me.mother.contactPhone ? 'Confirm your emergency contact' : 'Add an emergency contact'}</h1>
      <p class="muted">We’ll text this person a code. Ask them to share it with you so we can confirm they agree to be your emergency contact.</p>
      <form id="contactSetupForm" class="card">
        <label for="setupContactPhone">Emergency contact phone number</label>
        <input id="setupContactPhone" type="tel" inputmode="tel" autocomplete="off" value="${esc(currentPhone)}" placeholder="0772 123 456" required>
        <button class="full" type="submit">Send confirmation code</button>
      </form>
      <section id="contactCodePanel" class="card" hidden>
        <p id="contactCodeSent" class="muted" role="status" aria-live="polite"></p>
        <label for="setupContactCode">Code from their phone</label>
        <input id="setupContactCode" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 digits" required>
        <button class="full" id="confirmSetupContact" type="button">Confirm and continue</button>
        <button class="ghost full" id="resendSetupContact" type="button">Send another code</button>
      </section>
      <p id="contactSetupError" class="warn" role="alert" hidden></p>
      <button class="link full" id="contactLater" type="button">Not now, I will do this later</button>`);
    const form = $('#contactSetupForm'), send = form.querySelector('button[type=submit]');
    const panel = $('#contactCodePanel'), status = $('#contactCodeSent'), error = $('#contactSetupError');
    const showError = (message) => { error.textContent = message; error.hidden = false; };
    const requestCode = async () => {
      error.hidden = true;
      const result = await api('/api/contact/request', { method: 'POST' });
      status.textContent = `A code was sent to ${fmtPhone(result.sentTo)}. Ask them for the code. It expires in 10 minutes.` + (result.devCode ? ` Development code: ${result.devCode}.` : '');
      panel.hidden = false;
      $('#setupContactCode').value = '';
    };
    form.onsubmit = async (e) => {
      e.preventDefault(); error.hidden = true; send.disabled = true;
      try {
        me = await api('/api/me', { method: 'PATCH', body: { contactPhone: $('#setupContactPhone').value } });
        await requestCode();
      } catch (err) { showError(err.message); }
      finally { send.disabled = false; }
    };
    $('#resendSetupContact').onclick = async (e) => {
      const button = e.currentTarget; button.disabled = true;
      try { await requestCode(); }
      catch (err) { showError(err.message); }
      finally { button.disabled = false; }
    };
    $('#confirmSetupContact').onclick = async (e) => {
      const button = e.currentTarget; button.disabled = true; error.hidden = true;
      try {
        me = await api('/api/contact/verify', { method: 'POST', body: { code: $('#setupContactCode').value } });
        go('home'); say('Emergency contact confirmed. Thank you!');
      } catch (err) { showError(err.message); }
      finally { button.disabled = false; }
    };
    $('#contactBack').onclick = () => go('home'); $('#contactLater').onclick = () => go('home');
  }

  // ---------- visits ----------
  function renderVisits() {
    show(`<button type="button" class="link back" id="vback">← Home</button><h1>My visits</h1><p class="muted">8 antenatal contacts, planned from your due date. Dates already passed are shown faded.</p>
      ${me.visits.map((v) => `<div class="card visit ${v.status}"><div class="dot">${v.no}</div><div><b>Visit ${v.no} · week ${v.week}</b><div class="muted">${fmtDate(v.date)}${v.status === 'next' ? ' · NEXT' : ''}</div>${v.status === 'next' && me.facility ? `<div class="muted">${esc(me.facility.name)}</div>` : ''}</div></div>`).join('')}
      <p class="muted">Bring your antenatal card to every visit.</p>`);
    $('#vback').onclick = () => go('home');
  }

  // ---------- symptom check ----------
  // Pick what you feel, then get one clear answer with the next step as buttons.
  async function renderCheck() {
    const { symptoms } = await api('/api/symptoms');
    const groups = [
      ['emergency', 'Danger signs', 'Go to a health facility straight away'],
      ['urgent', 'Needs a check-up soon', 'Get checked today'],
      ['mild', 'Common and usually mild', 'Tell your health worker at your next visit']
    ];
    const label = Object.fromEntries(symptoms.map((x) => [x.id, x.label]));
    const picked = new Set();
    const draw = () => {
      show(`<button type="button" class="link back" id="checkBack">← Home</button>
        <h1>How are you feeling?</h1>
        <p class="muted">Tap everything you feel. We will tell you what to do next.</p>
        <div class="sosnudge"><span>Emergency right now?</span><button type="button" class="danger" data-check-go="sos">Open SOS</button></div>
        <form id="f" novalidate>${groups.map(([lvl, title, hint]) => `<section class="sympgroup ${lvl}"><h2>${title}</h2><p class="muted">${hint}</p>
          <div class="symlist">${symptoms.filter((x) => x.level === lvl).map((x) => `<label class="sym"><input type="checkbox" name="s" value="${esc(x.id)}" ${picked.has(x.id) ? 'checked' : ''}><span>${esc(x.label)}</span></label>`).join('')}</div></section>`).join('')}
          <p class="muted fine">This guide cannot diagnose you. If you are worried, contact your health worker.</p>
          <div class="checkbar"><span id="symptomCount" aria-live="polite"></span><button class="full" id="go" type="submit" disabled>See what to do</button></div>
        </form>`);
      $('#checkBack').onclick = () => go('home');
      document.querySelectorAll('[data-check-go]').forEach((bt) => { bt.onclick = () => go(bt.dataset.checkGo); });
      const sync = () => {
        const n = picked.size;
        $('#symptomCount').textContent = n ? `${n} selected` : 'Pick at least one';
        $('#go').disabled = !n;
      };
      document.querySelectorAll('input[name=s]').forEach((box) => { box.onchange = () => { box.checked ? picked.add(box.value) : picked.delete(box.value); sync(); }; });
      sync();
      $('#f').onsubmit = async (e) => {
        e.preventDefault();
        if (!picked.size) return;
        const btn = $('#go'); btn.disabled = true; btn.textContent = 'Checking…';
        try {
          const r = await api('/api/triage', { method: 'POST', body: { symptoms: [...picked] } });
          drawResult(r);
        } catch (err) { say(err.message || 'Could not check symptoms. Please try again.', true); btn.disabled = false; btn.textContent = 'See what to do'; }
      };
    };
    const drawResult = (r) => {
      const heads = { emergency: ['Go to a health facility now', 'Do not wait. Tell someone to go with you.'], urgent: ['Get checked today', 'Visit your clinic or a health facility today.'], mild: ['This is usually mild', 'Mention it at your next visit.'], none: ['Nothing selected', ''] };
      const [headline] = heads[r.level] || heads.none;
      const fac = me && me.facility, call = fac && bestPhone(fac);
      const next = me && me.next;
      const actions = r.level === 'emergency'
        ? `<button class="full danger" id="alert" type="button">Send emergency alert</button>
           <a class="btn full ghost" href="tel:${esc(cfg.emergencyNumber)}">Call ${esc(cfg.emergencyNumber)}</a>
           <button type="button" class="full ghost" data-result-go="ambulance">Find an ambulance</button>
           <button type="button" class="full ghost" data-result-go="care">Find the nearest hospital</button>`
        : r.level === 'urgent'
          ? `<button type="button" class="full" data-result-go="care">Find a health facility</button>
             ${call ? `<a class="btn full ghost" href="${telHref(call)}">Call ${esc(fac.name)}</a>` : ''}
             <button type="button" class="full ghost" data-result-go="chat">Ask MamaSafe a question</button>`
          : `<button type="button" class="full" data-result-go="chat">Ask MamaSafe a question</button>
             ${next ? `<p class="muted">Your next visit is ${esc(fmtDate(next.date))}.</p>` : ''}`;
      show(`<button type="button" class="link back" id="again">← Change my answers</button>
        <div class="result ${r.level}" role="status"><span class="resultkicker">${r.level === 'emergency' ? 'Act now' : r.level === 'urgent' ? 'Today' : 'For your next visit'}</span>
          <h2>${headline}</h2><p class="advice">${esc(r.advice)}</p></div>
        <div class="youfeel"><b>You told us</b><div class="chips">${[...picked].map((id) => `<span class="chip on">${esc(label[id] || id)}</span>`).join('')}</div></div>
        <div class="resultactions">${actions}</div>
        <p class="muted fine">If symptoms get worse or you are worried, seek care sooner. ${r.level === 'emergency' ? '' : `In an emergency call ${esc(cfg.emergencyNumber)} or open SOS.`}</p>
        <button type="button" class="link full" id="home2">Back to Home</button>`);
      $('#again').onclick = draw; $('#home2').onclick = () => go('home');
      const al = $('#alert'); if (al) al.onclick = () => sendAlert(r.matched);
      document.querySelectorAll('[data-result-go]').forEach((bt) => { bt.onclick = () => go(bt.dataset.resultGo); });
    };
    draw();
  }

  async function sendAlert(symptoms) {
    say('Sending your alert…');
    // Location is helpful but must never make an emergency alert wait on a slow GPS fix.
    const where = await locate(1200);
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
      <div class="card"><b>What happens next</b><div class="muted" style="color:var(--muted)">MamaSafe will try to alert your linked facility and your confirmed emergency contact. Nearby transport may be requested when available. If you need help now, call directly.</div></div>
      <button class="full ghost" type="button" id="bookAmbulance" style="margin:0 0 12px">Find and call an ambulance</button>
      <div class="card"><b>Call nearby transport</b><div class="muted" style="color:var(--muted)">See registered ambulances, boda riders and other available drivers near your location.</div><button class="full ghost" type="button" id="nearbyTransport">Find nearby transport</button><div id="transportResults" aria-live="polite"></div></div>
      <a class="btn full" style="background:#fff;color:#8e1b1b" href="tel:${esc(cfg.emergencyNumber)}">Or call ${esc(cfg.emergencyNumber)} now</a></div>`);
    $('#sos').onclick = () => sendAlert(['sos']);
    $('#bookAmbulance').onclick = () => go('ambulance');
    $('#nearbyTransport').onclick = async (e) => {
      const btn = e.currentTarget, results = $('#transportResults');
      btn.disabled = true; btn.textContent = 'Finding available transport…';
      try {
        const where = await locate(2500);
        const query = where ? `?lat=${encodeURIComponent(where.lat)}&lng=${encodeURIComponent(where.lng)}` : '';
        const r = await api('/api/transport/nearby' + query);
        results.innerHTML = r.transport.length
          ? `<p class="muted" style="color:var(--muted)">Call a provider directly. Availability can change, so confirm they can come before relying on the ride.</p>${r.transport.map((p) => `<a class="btn full ghost" href="${telHref(p.phone)}">Call ${esc(p.name)} · ${esc(p.kindLabel)}${p.distanceKm != null ? ' · ' + esc(p.distanceKm) + ' km' : ''}</a>`).join('')}`
          : `<p class="muted" style="color:var(--muted)">No registered nearby transport is available right now. Call ${esc(cfg.emergencyNumber)} or your health facility.</p>`;
      } catch (err) {
        results.innerHTML = `<p class="muted" style="color:var(--muted)">Could not load nearby transport. Call ${esc(cfg.emergencyNumber)} or your health facility now.</p>`;
      } finally { btn.disabled = false; btn.textContent = 'Refresh nearby transport'; }
    };
  }

  function showAlertSent(r) {
    const f = r.facility;
    const call = bestPhone(f);
    const told = r.notified
      ? `<div class="card"><b>${esc(f.name)} has been told.</b></div>`
      : `<div class="card"><b>${f ? 'Go to ' + esc(f.name) + '.' : 'Go to the nearest health facility.'}</b><div class="muted">We could not text them, so please call${call ? '' : ' ' + esc(cfg.emergencyNumber)}.</div></div>`;
    const contact = me && me.mother && me.mother.contactPhone ? '<div class="card"><b>Your emergency contact has been told.</b></div>' : '';
    show(`<div class="sosview"><h1>${r.demo ? 'Demo alert' : r.notified ? 'Alert sent' : 'Please call now'}</h1>${r.demo ? '<div class="card"><b>Demo mode.</b> Nothing was sent. No real clinic, driver or contact was contacted.</div>' : ''}<p class="muted">Go to the facility now if you can. Keep your phone with you.</p>
      ${told}${rideHtml(r.transport)}${contact}
      ${f && f.emergency_phone ? `<a class="btn full" style="background:#fff;color:#8e1b1b" href="${telHref(f.emergency_phone)}">Call emergency line ${esc(fmtPhone(f.emergency_phone))}</a>` : ''}
      ${call ? `<a class="btn full" style="background:#fff;color:#8e1b1b" href="${telHref(call)}">Call the facility ${esc(fmtPhone(call))}</a>` : ''}
      ${f && f.toll_free ? `<a class="btn full ghost" style="border-color:#fff;color:#fff" href="${telHref(f.toll_free)}">Toll-free ${esc(fmtPhone(f.toll_free))}</a>` : ''}
      ${f ? `<a class="btn full ghost" style="border-color:#fff;color:#fff" target="_blank" rel="noopener" href="${esc(dirUrl(f))}">Directions</a>` : ''}
      <a class="btn full ghost" style="border-color:#fff;color:#fff" href="tel:${esc(cfg.emergencyNumber)}">Call ${esc(cfg.emergencyNumber)}</a></div>`);
  }

  // Transport: who was asked to collect her, and drivers she can call herself. Numbers come from staff-registered
  // drivers only; nothing is invented. The server texts the nearest drivers, so she does not have to wait for a call.
  function rideHtml(t) {
    t = t || { asked: 0, nearby: [] };
    const head = t.asked
      ? `<div class="card"><b>${t.asked} nearby driver${t.asked > 1 ? 's were' : ' was'} asked to come to you.</b><div class="muted">You will get an SMS when one accepts. You can also call one now.</div></div>`
      : `<div class="card"><b>Need a ride?</b><div class="muted">${t.nearby.length ? 'No driver has been asked yet. Call one below.' : 'We have no registered driver near you. Ask a neighbour or call ' + esc(cfg.emergencyNumber) + '.'}</div></div>`;
    const calls = (t.nearby || []).slice(0, 3).map((p) =>
      `<a class="btn full ghost" href="${telHref(p.phone)}">Call ${esc(p.name)} · ${esc(p.kindLabel)}${p.distanceKm != null ? ' · ' + esc(p.distanceKm) + ' km' : ''}</a>`).join('');
    return head + calls;
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
      list: ['Alerts your health facility, with your location if you allow it', 'Texts your emergency contact', 'Asks nearby drivers to collect you', 'Shows phone numbers to call straight away', 'Always free. Always works, even if you have not paid'] }
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
        <ul><li>tell your health facility (with your location if your phone shares it)</li><li>ask nearby registered drivers (ambulance, boda, taxi) to collect you; the first to accept texts you</li><li>text your emergency contact</li><li>text you a confirmation</li></ul>
        <p>If the facility has no mobile number for alerts, the app tells you honestly: <b>"We could not text them, please call"</b> and shows every phone number we hold. Press the call buttons.</p>
        <div class="callout red"><b>SOS cannot promise a vehicle.</b> It asks registered drivers near you, but nobody is guaranteed to come. Go to the facility if you can, and call ${esc(em)} if you cannot get there. Keep your phone with you.</div>
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

  // ---------- find care and transport near me: full-screen map with a bottom sheet (works signed in or not) ----------
  const CHIPS = [['', 'All'], ['hospital', 'Hospitals'], ['clinic', 'Clinics'], ['health_centre', 'Health centres'], ['government', 'Government'], ['open24', 'Open 24h']];
  const chipOn = (v) => (v === 'open24' ? care.open24 : v === 'government' ? care.ownership === 'government' : v === 'health_centre' ? care.kind === 'health_centre' && care.ownership !== 'government' : !care.open24 && !care.ownership && care.kind === v);
  const MODES = [['hospitals', 'Hospitals'], ['ambulance', 'Ambulance'], ['boda', 'Boda & cars']];
  // A light grey base map, like the ride apps. Swap TILE_URL for 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' to use plain OpenStreetMap.
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const TILE_ATTR = '&copy; OpenStreetMap contributors';
  const PIN_SVG = '<svg viewBox="0 0 24 32" width="40" height="54" aria-hidden="true"><path d="M12 0C5.4 0 0 5.2 0 11.7 0 20 12 32 12 32s12-12 12-20.3C24 5.2 18.6 0 12 0z" fill="#a34d38"/><circle cx="12" cy="11.5" r="4.5" fill="#fff"/></svg>';
  let drivers = [], facById = new Map(), careSeq = 0;

  function markerNode(kind, f, sel) {
    const d = document.createElement('div');
    if (kind === 'fac') { d.className = 'mk fac ' + (f.kind || '') + (sel ? ' sel' : ''); d.textContent = f.kind === 'clinic' ? '+' : 'H'; }
    else if (kind === 'drv') { d.className = 'mk drv' + (sel ? ' sel' : ''); d.textContent = f.kind === 'ambulance' ? '🚑' : '🏍'; }
    else { d.className = 'youdot'; d.textContent = 'YOU'; }
    d.title = kind === 'you' ? 'You are here' : f.name;
    return d;
  }

  function sizeMapView() {
    const mv = document.getElementById('mapview'); if (!mv) return;
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    const navH = nav.hidden ? 0 : nav.offsetHeight;
    const h = Math.max(420, Math.round(vh - mv.getBoundingClientRect().top - navH));
    mv.style.height = h + 'px';
    applySheet();
    if (mapHandle) mapHandle.invalidate();
  }
  function sheetPx() {
    const mv = document.getElementById('mapview'); if (!mv) return 0;
    const h = mv.clientHeight;
    if (care.pick) return 128;
    return { peek: 236, half: Math.max(340, Math.round(h * 0.5)), full: Math.round(h * 0.9) }[care.sheet] || 340;
  }
  function applySheet() {
    const mv = document.getElementById('mapview'); if (!mv) return;
    mv.dataset.state = care.pick ? 'pick' : care.sheet;
    mv.style.setProperty('--sh', sheetPx() + 'px');
  }
  window.addEventListener('resize', sizeMapView);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', sizeMapView);

  async function renderCare() {
    const signedIn = !!(me && me.registered);
    if (!signedIn) nav.hidden = true;
    const lines = (cfg.helplines || []).filter((l) => l.confidence !== 'low' && l.number !== cfg.emergencyNumber && l.kind !== 'emergency');
    if (!signedIn) care.mode = 'hospitals';
    care.pick = false; care.sel = null;
    show(`<div class="mapview" id="mapview">
      <div id="map" role="region" aria-label="Map of health facilities and transport"></div>
      <button type="button" class="rbtn mback" id="mback" aria-label="Back">${svg('<path d="m15 5-7 7 7 7"/>')}</button>
      <button type="button" class="rbtn locate" id="locate" aria-label="Show my location">${svg('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>')}</button>
      <div class="cpin" id="cpin" hidden>${PIN_SVG}</div>
      <section class="sheet" id="sheet" aria-label="Find care and transport">
        <button type="button" class="grab" id="grab" aria-label="Show more or less"><span></span></button>
        <div class="sbody" id="sbody">
          ${signedIn ? `<div class="modes" role="group" aria-label="What are you looking for">${MODES.map(([v, t]) => `<button type="button" data-mode="${v}" aria-pressed="${care.mode === v}">${t}</button>`).join('')}</div>` : ''}
          <div class="fld pick"><span class="dot"></span><b>Pick up</b><span class="val" id="picktxt"></span><button type="button" id="pickedit" aria-label="Choose pick-up on the map">${svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>')}</button></div>
          <div class="fld where" id="wherefld"><b>Where to</b><input id="q" type="search" placeholder="Type a hospital or district" value="${esc(care.q)}" autocomplete="off" aria-label="Hospital or district"><button type="button" id="qclear" aria-label="Clear search" ${care.q ? '' : 'hidden'}>${svg('<path d="M6 6l12 12M18 6 6 18"/>')}</button></div>
          <div class="uses"><button type="button" class="link" id="usecur">${svg('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>')} Use current location</button><button type="button" class="link" id="usemap">Use map ${svg('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>')}</button></div>
          <p class="location-attribution">Approximate area names by <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>.</p>
          <div class="chips" id="chips" role="group" aria-label="Filter">${CHIPS.map(([v, t]) => `<button type="button" class="chip" data-chip="${v}" aria-pressed="${chipOn(v)}">${t}</button>`).join('')}</div>
          <p id="count" class="muted" aria-live="polite"></p>
          <div id="results"></div>
          <button class="ghost full" id="more" type="button" hidden>Show more</button>
          <div class="card helplines"><div class="hl first"><div><b>Emergency</b><div class="muted">Police and general emergency. 112 also works.</div></div><a class="btn danger" href="tel:${esc(cfg.emergencyNumber)}">Call ${esc(cfg.emergencyNumber)}</a></div>
            ${lines.length ? `<details><summary>Toll-free health lines</summary>${lines.map((l) => `<div class="hl"><div><b>${esc(l.name)}</b><div class="muted">${esc(l.note || '')}</div></div><a class="btn tf" href="${telHref(l.tel)}">${esc(l.number)}</a></div>`).join('')}${cfg.helplinesChecked ? `<div class="muted">Numbers last checked ${esc(cfg.helplinesChecked)}.</div>` : ''}</details>` : ''}</div>
          <p class="muted">Facility details come from public sources and may be out of date. Call ahead if you can. In an emergency go to the nearest hospital or call ${esc(cfg.emergencyNumber)}.</p>
        </div>
        <div class="pickbar" id="pickbar"><b>Move the map to your pick-up point</b><div class="row"><button type="button" id="pickok">Confirm pick-up</button><button type="button" class="ghost" id="pickcancel">Cancel</button></div></div>
      </section></div>`);
    main.classList.add('mapmode'); document.body.classList.add('mapmode');
    const mv = $('#mapview');
    const paintPick = () => {
      $('#picktxt').textContent = !pos ? 'Location is off'
        : pos.manual ? 'Point you chose on the map'
          : `My location · ${pos.place || `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`}${Number.isFinite(pos.accuracy) ? ` · ±${Math.max(1, Math.round(pos.accuracy))} m` : ''}`;
    };
    const paintMode = () => {
      const hosp = care.mode === 'hospitals';
      $('#wherefld').hidden = !hosp; $('#chips').hidden = !hosp;
      document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.mode === care.mode));
    };
    const where = (f) => (f && f.lat != null ? { lat: f.lat, lng: f.lng } : null);
    const mapSet = (o) => { if (mapHandle) mapHandle.set({ you: pos, pad: sheetPx(), ...o }); };
    const refresh = () => (care.mode === 'hospitals' ? refreshCare(mapSet, paintSel) : refreshDrivers(mapSet));
    function paintSel() {
      const f = facById.get(care.sel);
      const box = $('#selcard'); if (box) box.remove();
      if (!f) return;
      const el = document.createElement('div'); el.id = 'selcard'; el.className = 'card selcard';
      el.innerHTML = `<div class="fac-head"><span class="hb">H</span><div class="grow"><h3>${esc(f.name)}</h3><div class="muted">${esc(facilityLabel(f))}${f.level ? ' · ' + esc(f.level) : ''} · ${esc(f.area)}${f.distanceKm != null ? ' · <b>' + f.distanceKm + ' km</b>' : ''}</div></div><button type="button" class="x" id="selx" aria-label="Close details">${svg('<path d="M6 6l12 12M18 6 6 18"/>')}</button></div>
        <div class="tags">${f.open24 === true ? '<span class="tag ok">Open 24 hours</span>' : f.open24 === false ? '<span class="tag">Daytime only</span>' : '<span class="tag">Hours not confirmed</span>'}</div>
        ${f.services ? `<div class="muted">${esc(f.services)}</div>` : ''}${contactHtml(f)}
        <div class="row"><a class="btn" target="_blank" rel="noopener" href="${esc(dirUrl(f))}">Directions</a>${signedIn ? '<button type="button" class="ghost" id="selride">Get a ride</button>' : ''}${safeUrl(f.website) ? `<a class="btn ghost" target="_blank" rel="noopener" href="${esc(f.website)}">Website</a>` : ''}</div>`;
      $('#sbody').prepend(el); $('#sbody').scrollTop = 0;
      $('#selx').onclick = () => { care.sel = null; paintSel(); mapSet({ facilities: [...facById.values()], drivers: [], selId: null }); };
      const ride = $('#selride'); if (ride) ride.onclick = () => { care.mode = 'ambulance'; care.sel = null; paintMode(); paintSel(); refresh(); };
    }
    paintPick(); paintMode(); sizeMapView();

    // --- sheet: tap or swipe the handle
    const order = ['peek', 'half', 'full'];
    const grab = $('#grab'); let y0 = null;
    grab.addEventListener('pointerdown', (e) => { y0 = e.clientY; grab.setPointerCapture(e.pointerId); });
    grab.addEventListener('pointerup', (e) => {
      if (y0 == null) return; const dy = e.clientY - y0; y0 = null; let i = order.indexOf(care.sheet);
      if (Math.abs(dy) < 8) i = care.sheet === 'peek' ? 1 : care.sheet === 'half' ? 2 : 1; else i = Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)));
      care.sheet = order[i]; applySheet(); if (mapHandle) mapHandle.invalidate();
    });
    grab.addEventListener('pointercancel', () => { y0 = null; });
    $('#mback').onclick = () => go(signedIn ? 'home' : 'auth');

    // --- pick-up
    const useCurrent = async () => {
      const buttons = [$('#locate'), $('#usecur')].filter(Boolean);
      buttons.forEach((b) => { b.disabled = true; });
      say('Getting a fresh location from your device…');
      try {
        const p = await locate();
        if (!p) {
          say('Could not get a fresh GPS location. Allow location access and precise location in your device settings, or choose a point on the map.', true);
          return;
        }
        say('Looking up your area…');
        try {
          const area = await api(`/api/location/reverse?lat=${encodeURIComponent(p.lat)}&lng=${encodeURIComponent(p.lng)}`);
          if (area.location) p.place = area.location.place;
        } catch { /* GPS position and nearby search still work if area lookup is unavailable. */ }
        pos = p;
        paintPick();
        await refresh();
        if (mapHandle) mapHandle.focus(p.lat, p.lng, sheetPx());
      } finally { buttons.forEach((b) => { b.disabled = false; }); }
    };
    $('#locate').onclick = useCurrent; $('#usecur').onclick = useCurrent;
    const startPick = () => { care.pick = true; $('#cpin').hidden = false; applySheet(); if (mapHandle) { mapHandle.invalidate(); if (pos) mapHandle.focus(pos.lat, pos.lng, 0); } };
    const endPick = () => { care.pick = false; $('#cpin').hidden = true; applySheet(); if (mapHandle) mapHandle.invalidate(); };
    $('#usemap').onclick = startPick; $('#pickedit').onclick = startPick;
    $('#pickcancel').onclick = endPick;
    $('#pickok').onclick = () => { const c = mapHandle && mapHandle.getCenter(); if (c) { pos = { lat: c.lat, lng: c.lng, manual: true }; paintPick(); } endPick(); refresh(); };

    // --- modes and search
    document.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { care.mode = b.dataset.mode; care.sel = null; paintMode(); paintSel(); refresh(); }; });
    let timer = null;
    $('#q').oninput = (e) => { care.q = e.target.value; care.limit = 20; care.sel = null; $('#qclear').hidden = !care.q; clearTimeout(timer); timer = setTimeout(refresh, 300); };
    $('#q').onfocus = () => { if (care.sheet !== 'full') { care.sheet = 'full'; applySheet(); } };
    $('#qclear').onclick = () => { care.q = ''; $('#q').value = ''; $('#qclear').hidden = true; refresh(); };
    $('#chips').onclick = (e) => {
      const c = e.target.closest('[data-chip]'); if (!c) return;
      const v = c.dataset.chip;
      care.open24 = v === 'open24'; care.kind = v === 'government' ? '' : v === 'health_centre' ? 'health_centre' : care.open24 ? '' : v; care.ownership = v === 'government' ? 'government' : ''; care.limit = 20;
      document.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', chipOn(x.dataset.chip)));
      refresh();
    };
    $('#more').onclick = () => { care.limit = Math.min(care.limit + 20, 100); refresh(); };
    $('#results').onclick = (e) => {
      const r = e.target.closest('[data-fid]'); if (!r) return;
      care.sel = Number(r.dataset.fid); paintSel(); care.sheet = 'half'; applySheet();
      const f = facById.get(care.sel); mapSet({ facilities: [...facById.values()], drivers: [], selId: care.sel });
      if (mapHandle && where(f)) mapHandle.focus(f.lat, f.lng, sheetPx());
    };
    // The list never waits for the map: on a slow connection the numbers matter more than the pins.
    mapHandle = createMap($('#map'), {
      facility: (f) => { care.sel = f.id; care.sheet = care.sheet === 'peek' ? 'half' : care.sheet; applySheet(); paintSel(); mapSet({ facilities: [...facById.values()], drivers: [], selId: f.id }); const el = $('#selcard'); if (el) el.scrollIntoView({ block: 'nearest' }); },
      driver: () => { const r = document.querySelector('.srow.drv'); if (r) r.scrollIntoView({ block: 'nearest' }); }
    });
    refresh();
  }

  async function refreshCare(mapSet, paintSel) {
    const seq = ++careSeq;
    const qs = new URLSearchParams({ limit: String(care.limit) });
    if (care.q.trim()) qs.set('q', care.q.trim());
    if (care.kind) qs.set('kind', care.kind);
    if (care.ownership) qs.set('ownership', care.ownership);
    if (care.open24) qs.set('open24', '1');
    if (pos) { qs.set('lat', pos.lat); qs.set('lng', pos.lng); }
    let data;
    try { data = await api('/api/facilities?' + qs); } catch (e) { say(e.status ? e.message : 'No internet connection. Call ' + cfg.emergencyNumber + ' in an emergency.', true); return; }
    if (seq !== careSeq || view !== 'care' || care.mode !== 'hospitals') return; // a newer search or another screen took over
    say('');
    const { facilities, total } = data;
    facById = new Map(facilities.map((f) => [f.id, f]));
    $('#count').textContent = total ? `Showing ${facilities.length} of ${total}${pos ? ', nearest first' : ''}.` : '';
    $('#more').hidden = facilities.length >= total || care.limit >= 100;
    $('#results').innerHTML = facilities.length ? facilities.map((f) => `<button type="button" class="srow" id="fac-${f.id}" data-fid="${f.id}"><span class="hb ${f.kind === 'clinic' ? 'sm' : ''}">${f.kind === 'clinic' ? '+' : 'H'}</span><span class="grow"><b>${esc(f.name)}</b><span class="muted">${esc(facilityLabel(f))} · ${esc(f.area)}${f.distanceKm != null ? ' · <b>' + f.distanceKm + ' km</b>' : ''}${f.open24 === true ? ' · Open 24h' : ''}</span></span><span class="go" aria-hidden="true">${svg('<path d="M7 17 17 7M8 7h9v9"/>')}</span></button>`).join('')
      : '<div class="card"><b>No facility found.</b><p class="muted">Try a different spelling, or the name of your district. Call ' + esc(cfg.emergencyNumber) + ' in an emergency.</p></div>';
    paintSel();
    mapSet({ facilities, drivers: [], selId: care.sel, fit: !care.sel });
  }

  async function refreshDrivers(mapSet) {
    const seq = ++careSeq;
    const qs = pos ? `?lat=${pos.lat}&lng=${pos.lng}` : '';
    let list;
    try { list = (await api('/api/transport/nearby' + qs)).transport; } catch (e) { say(e.status ? e.message : 'No internet connection. Call ' + cfg.emergencyNumber + ' in an emergency.', true); return; }
    if (seq !== careSeq || view !== 'care' || care.mode === 'hospitals') return;
    say('');
    drivers = list.filter((d) => (care.mode === 'ambulance' ? d.kind === 'ambulance' : d.kind !== 'ambulance'));
    $('#count').textContent = '';
    $('#more').hidden = true;
    const none = care.mode === 'ambulance' ? 'No ambulance is listed near you yet.' : 'No boda or car is listed near you yet.';
    $('#results').innerHTML = (pos ? '' : '<div class="card"><b>Turn on your location</b><p class="muted">Then we can show who is nearest to you. Until then you see drivers for your clinic\'s area.</p></div>')
      + (drivers.length ? drivers.map((d) => `<div class="srow drv" id="drv-${d.id}"><span class="hb drvi" aria-hidden="true">${d.kind === 'ambulance' ? '🚑' : '🏍'}</span><span class="grow"><b>${esc(d.name)}</b><span class="muted">${esc(d.kindLabel)}${d.area ? ' · ' + esc(d.area) : ''}${d.distanceKm != null ? ' · <b>' + d.distanceKm + ' km</b>' : ''}</span></span>${d.phone ? `<a class="btn callbtn" href="${telHref(d.phone)}" aria-label="Call ${esc(d.name)}">Call</a>` : ''}</div>`).join('')
        : `<div class="card"><b>${none}</b><p class="muted">Press SOS and we alert your clinic. Or call ${esc(cfg.emergencyNumber)}.</p></div>`)
      + '<p class="muted">In an emergency, press SOS: the nearest drivers are asked to come for you automatically.</p>';
    mapSet({ facilities: [], drivers, selId: null, fit: true });
  }

  // ---------- maps: Google when a key is configured, otherwise a light OpenStreetMap-based map ----------
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

  // cb = { facility(f), driver(d) }. impl API: set({facilities, drivers, you, selId, fit, pad}), focus(lat, lng, pad), getCenter(), invalidate(), destroy()
  function createMap(el, cb) {
    let impl = null, dead = false, last = null, queuedFocus = null;
    const applyQueuedFocus = () => {
      if (!impl || !queuedFocus) return;
      impl.focus(...queuedFocus);
      queuedFocus = null;
    };
    const handle = {
      google: false,
      set(o) { last = o; if (impl) impl.set(o); },
      focus(lat, lng, pad) { if (impl) impl.focus(lat, lng, pad); else queuedFocus = [lat, lng, pad]; },
      getCenter() { return impl ? impl.getCenter() : null; },
      invalidate() { if (impl) impl.invalidate(); },
      destroy() { dead = true; queuedFocus = null; if (impl) impl.destroy(); impl = null; },
      fallback() {
        if (impl) impl.destroy();
        el.innerHTML = ''; handle.google = false;
        impl = leafletMap(el, cb);
        if (impl) { if (last) impl.set(last); applyQueuedFocus(); }
        else if (el.isConnected) el.innerHTML = '<p class="muted" style="padding:80px 20px">The map could not load. The list below still works.</p>';
      }
    };
    loadGoogle()
      .then(() => googleMap(el, cb))
      .then((m) => { if (dead) return m.destroy(); impl = m; handle.google = true; if (last) impl.set(last); applyQueuedFocus(); })
      .catch(() => { if (!dead) handle.fallback(); });
    return handle;
  }

  async function googleMap(el, cb) {
    const { Map } = await google.maps.importLibrary('maps');
    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
    const map = new Map(el, {
      center: { lat: 1.37, lng: 32.29 }, zoom: 7, mapId: cfg.googleMapId || 'DEMO_MAP_ID',
      restriction: { latLngBounds: { north: 4.25, south: -1.5, west: 29.55, east: 35.05 }, strictBounds: true },
      disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false
    });
    let markers = [];
    const add = (node, lat, lng, title, onClick, z) => { const m = new AdvancedMarkerElement({ map, position: { lat, lng }, content: node, title, zIndex: z || 1 }); if (onClick) m.addListener('click', onClick); markers.push(m); };
    return {
      set({ facilities = [], drivers = [], you, selId, fit, pad = 0 }) {
        markers.forEach((m) => { m.map = null; }); markers = [];
        const bounds = new google.maps.LatLngBounds();
        facilities.forEach((f) => { if (f.lat == null) return; add(markerNode('fac', f, f.id === selId), f.lat, f.lng, f.name, () => cb.facility(f), f.id === selId ? 9 : 2); bounds.extend({ lat: f.lat, lng: f.lng }); });
        drivers.forEach((d) => { if (d.lat == null) return; add(markerNode('drv', d, false), d.lat, d.lng, d.name, () => cb.driver(d)); bounds.extend({ lat: d.lat, lng: d.lng }); });
        if (you) { add(markerNode('you'), you.lat, you.lng, 'You are here', null, 10); bounds.extend({ lat: you.lat, lng: you.lng }); }
        if (fit && !bounds.isEmpty()) { map.fitBounds(bounds, { top: 70, left: 40, right: 40, bottom: pad + 20 }); google.maps.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 15) map.setZoom(15); }); }
      },
      focus(lat, lng, pad) { map.setCenter({ lat, lng }); map.setZoom(15); if (pad) map.panBy(0, pad / 2); },
      getCenter() { const c = map.getCenter(); return { lat: c.lat(), lng: c.lng() }; },
      invalidate() { google.maps.event.trigger(map, 'resize'); },
      destroy() { markers.forEach((m) => { m.map = null; }); markers = []; el.innerHTML = ''; }
    };
  }

  function leafletMap(el, cb) {
    if (!window.L) return null;
    const UG = L.latLngBounds([-1.5, 29.55], [4.25, 35.05]); // Uganda map bounds.
    const map = L.map(el, { zoomControl: false, maxBounds: UG, maxBoundsViscosity: 1, minZoom: 6 });
    const lockZoom = () => { try { map.setMinZoom(Math.max(6, map.getBoundsZoom(UG, true))); } catch { /* ignore */ } };
    L.control.zoom({ position: 'topright' }).addTo(map);
    const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(map);
    // If OpenStreetMap tiles fail on this network, switch to a backup tile source.
    let bad = 0, swapped = false;
    tiles.on('tileerror', () => {
      if (swapped || ++bad < 3) return;
      swapped = true; map.removeLayer(tiles);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri' }).addTo(map);
    });
    map.setView([0.3476, 32.5825], 11); // Kampala
    lockZoom();
    const layer = L.layerGroup().addTo(map);
    const icon = (node, size) => L.divIcon({ className: '', html: node, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    return {
      set({ facilities = [], drivers = [], you, selId, fit, pad = 0 }) {
        layer.clearLayers();
        const pts = [];
        facilities.forEach((f) => { if (f.lat == null) return; L.marker([f.lat, f.lng], { title: f.name, icon: icon(markerNode('fac', f, f.id === selId), 30), zIndexOffset: f.id === selId ? 1000 : 0 }).addTo(layer).on('click', () => cb.facility(f)); pts.push([f.lat, f.lng]); });
        drivers.forEach((d) => { if (d.lat == null) return; L.marker([d.lat, d.lng], { title: d.name, icon: icon(markerNode('drv', d, false), 34) }).addTo(layer).on('click', () => cb.driver(d)); pts.push([d.lat, d.lng]); });
        if (you) { L.marker([you.lat, you.lng], { title: `You are here · ${you.lat.toFixed(5)}, ${you.lng.toFixed(5)}`, icon: icon(markerNode('you'), 38), zIndexOffset: 2000, interactive: false }).addTo(layer); pts.push([you.lat, you.lng]); }
        // Ignore points outside Uganda so one bad coordinate cannot zoom the map out to the whole continent.
        const inUg = pts.filter((q) => q[0] > -1.6 && q[0] < 4.4 && q[1] > 29.4 && q[1] < 35.1);
        if (fit) { map.invalidateSize(); lockZoom(); }
        if (fit && !inUg.length) map.setView([0.3476, 32.5825], 11);
        else if (fit) map.fitBounds(inUg, { paddingTopLeft: [40, 70], paddingBottomRight: [40, pad + 20], maxZoom: 15 });
      },
      focus(lat, lng, pad) { map.fitBounds([[lat, lng]], { paddingTopLeft: [40, 70], paddingBottomRight: [40, (pad || 0) + 20], maxZoom: 15 }); },
      getCenter() { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
      invalidate() { map.invalidateSize(); lockZoom(); },
      destroy() { map.remove(); }
    };
  }

  $('#helpbtn').onclick = () => openGuide();
  nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) go(b.dataset.view); });

  (async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    try { cfg = await api('/api/config'); } catch { /* offline: defaults */ }
    if (!token) return go('auth');
    // A returning mother never sees the sign-in screen: show a short loading screen, then Home.
    show('<div class="splash" role="status" aria-label="Loading MamaSafe"><img src="/logo.png" alt="" width="72" height="72"><p>MamaSafe</p></div>', true);
    nav.hidden = true;
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

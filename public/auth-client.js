// Shared OTP + Google sign-in client for /signup.html and /login.html.
// Drives the same DOM shape: #phone, #step-phone, #step-otp, #sendOtpBtn,
// #verifyOtpBtn, #resendBtn, #resendTimer, #otpPhoneEcho, #debugCode,
// .otp-input × 6, #errBox, #langBtn, #g_id_signin.
(function () {
  const $ = s => document.querySelector(s);

  // Honor a ?next=… query param so deep-links survive sign-in.
  // Examples:
  //   /apply.html?service=140013     → bounces to /login.html?next=…
  //   user signs in (or signs up)    → returns to the resolved next URL
  // Falls back to /account.html if the param is missing or unsafe.
  function resolveNextUrl() {
    try {
      const raw = new URLSearchParams(location.search).get('next');
      if (!raw) return '/account.html';
      const decoded = decodeURIComponent(raw);
      // Same-origin only — refuse anything starting with a scheme or "//".
      if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/account.html';
      return decoded;
    } catch { return '/account.html'; }
  }
  const NEXT_URL = resolveNextUrl();

  const phoneInput = $('#phone');
  const sendBtn = $('#sendOtpBtn');
  const verifyBtn = $('#verifyOtpBtn');
  const errBox = $('#errBox');
  const stepPhone = $('#step-phone');
  const stepOtp = $('#step-otp');
  const otpInputs = [...document.querySelectorAll('.otp-input')];
  const phoneEcho = $('#otpPhoneEcho');
  const debugCodeBox = $('#debugCode');
  const resendBtn = $('#resendBtn');
  const resendTimer = $('#resendTimer');
  const langBtn = $('#langBtn');
  let cooldownSec = 0;
  let cooldownTimer = null;
  let phoneE164 = '';

  if (langBtn) langBtn.onclick = () => I18N.setLang(I18N.lang === 'ar' ? 'en' : 'ar');

  function showErr(msg) {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  }
  function clearErr() {
    if (!errBox) return;
    errBox.classList.add('hidden');
    errBox.textContent = '';
  }
  function setStep(name) {
    if (name === 'phone') { stepPhone.classList.remove('hidden'); stepOtp.classList.add('hidden'); }
    else { stepPhone.classList.add('hidden'); stepOtp.classList.remove('hidden'); setTimeout(() => otpInputs[0]?.focus(), 50); }
  }
  function startCooldown(s) {
    cooldownSec = s;
    if (resendBtn) resendBtn.disabled = true;
    if (cooldownTimer) clearInterval(cooldownTimer);
    const tick = () => {
      if (cooldownSec <= 0) {
        clearInterval(cooldownTimer); cooldownTimer = null;
        if (resendBtn) resendBtn.disabled = false;
        if (resendTimer) resendTimer.textContent = '';
      } else {
        if (resendTimer) resendTimer.textContent = `(${cooldownSec--}s)`;
      }
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
  }

  // Try to anticipate the server's E.164 normalization so we can echo it back.
  function previewE164(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (/^\d{8}$/.test(digits)) return '+968' + digits;
    if (/^968\d{8}$/.test(digits)) return '+' + digits;
    return digits ? '+' + digits : '';
  }

  async function sendOtp() {
    clearErr();
    const raw = phoneInput?.value.trim();
    if (!raw) return showErr(I18N.t('auth.err.phone_required'));
    if (sendBtn) sendBtn.disabled = true;
    try {
      const r = await fetch('/api/citizen-auth/start-otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: raw })
      });
      const d = await r.json();
      if (!r.ok) {
        if (d.error === 'cooldown') {
          startCooldown(d.retry_in_s || 30);
          showErr(I18N.t('auth.err.cooldown'));
        } else {
          showErr(I18N.t('auth.err.' + d.error) || I18N.t('auth.err.generic'));
        }
        return;
      }
      phoneE164 = previewE164(raw);
      if (phoneEcho) phoneEcho.textContent = phoneE164 || raw;
      setStep('otp');
      startCooldown(d.cooldown_s || 30);
      if (d.debug_code && debugCodeBox) {
        debugCodeBox.classList.remove('hidden');
        debugCodeBox.textContent = `DEBUG: code = ${d.debug_code}`;
      }
    } catch (e) {
      showErr(I18N.t('auth.err.network'));
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  async function verifyOtp() {
    clearErr();
    const code = otpInputs.map(x => x.value).join('');
    if (code.length !== 6) return;
    if (verifyBtn) verifyBtn.disabled = true;
    try {
      const r = await fetch('/api/citizen-auth/verify-otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phoneE164, code })
      });
      const d = await r.json();
      if (!r.ok) {
        showErr(I18N.t('auth.err.' + d.error) || I18N.t('auth.err.generic'));
        otpInputs.forEach(x => { x.value = ''; x.classList.remove('has-value'); });
        otpInputs[0]?.focus();
        return;
      }
      window.location.href = NEXT_URL;
    } catch (e) {
      showErr(I18N.t('auth.err.network'));
    } finally {
      if (verifyBtn) verifyBtn.disabled = false;
    }
  }

  if (sendBtn)   sendBtn.addEventListener('click', sendOtp);
  if (phoneInput) phoneInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendOtp(); });
  if (verifyBtn) verifyBtn.addEventListener('click', verifyOtp);
  $('#backToPhone')?.addEventListener('click', () => {
    setStep('phone');
    otpInputs.forEach(x => { x.value = ''; x.classList.remove('has-value'); });
  });
  if (resendBtn) resendBtn.addEventListener('click', () => sendOtp());

  otpInputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      input.classList.toggle('has-value', !!input.value);
      if (input.value && i < otpInputs.length - 1) otpInputs[i+1].focus();
      if (otpInputs.every(x => x.value)) verifyOtp();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && i > 0) otpInputs[i-1].focus();
    });
    input.addEventListener('paste', e => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const digits = text.replace(/\D/g, '').slice(0, 6);
      if (digits.length === 6) {
        e.preventDefault();
        otpInputs.forEach((inp, idx) => { inp.value = digits[idx]; inp.classList.add('has-value'); });
        verifyOtp();
      }
    });
  });

  // Google sign-in
  window.handleGoogleCredential = async function (resp) {
    clearErr();
    try {
      const r = await fetch('/api/citizen-auth/google', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id_token: resp.credential })
      });
      const d = await r.json();
      if (!r.ok) return showErr(I18N.t('auth.err.google'));
      window.location.href = NEXT_URL;
    } catch (e) {
      showErr(I18N.t('auth.err.network'));
    }
  };

  (async () => {
    let tries = 0;
    while (!window.google?.accounts?.id && tries++ < 30) {
      await new Promise(r => setTimeout(r, 100));
    }
    const wrap = $('#googleBtnWrap');
    if (!window.google?.accounts?.id) {
      if (wrap) wrap.innerHTML = `<div class="text-xs text-slate-400 italic">${I18N.t('auth.google_disabled')}</div>`;
      return;
    }
    const clientId = window.SANAD_GOOGLE_CLIENT_ID || '';
    if (!clientId) {
      if (wrap) wrap.innerHTML = `<div class="text-xs text-slate-400 italic">${I18N.t('auth.google_disabled')}</div>`;
      return;
    }
    google.accounts.id.initialize({
      client_id: clientId,
      callback: window.handleGoogleCredential
    });
    google.accounts.id.renderButton(document.getElementById('g_id_signin'), {
      type: 'standard', theme: 'outline', size: 'large', shape: 'pill', width: 280,
      text: 'continue_with', logo_alignment: 'center'
    });
  })();

  // ── Debug-mode quick-sign-in shortcut ────────────────────────
  // When DEBUG_MODE=true on the server (/api/health → {debug:true}), drop a
  // small "Skip OTP (test)" button under the phone form. Click → uses a
  // canned test phone if the input is empty, calls /start-otp to mint a
  // code, reads the debug_code from the response, fills the 6 OTP boxes,
  // and submits verify-otp. Lands on /account.html in ~400 ms with no
  // real WhatsApp round-trip.
  //
  // Production-safe: the /api/health check returns debug:false, so the
  // button never renders.
  (async () => {
    let isDebug = false;
    try {
      const h = await fetch('/api/health').then(r => r.json());
      isDebug = !!h.debug;
    } catch {}
    if (!isDebug || !stepPhone) return;

    const wrap = document.createElement('div');
    wrap.className = 'mt-4 p-3 rounded-xl border border-amber-200 bg-amber-50';
    wrap.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        <span class="text-[10px] font-extrabold uppercase tracking-wider text-amber-700 bg-amber-200 px-2 py-0.5 rounded">DEBUG</span>
        <span class="text-[11px] font-semibold text-amber-800">Test shortcuts (hidden in production)</span>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" id="dbgAutoFillBtn"
          class="text-xs font-bold text-amber-900 bg-white hover:bg-amber-100 border border-amber-300 px-3 py-1.5 rounded-lg shadow-sm">
          🔑 Generate OTP &amp; auto-fill
        </button>
        <button type="button" id="dbgMagicBtn"
          class="text-xs font-bold text-amber-900 bg-white hover:bg-amber-100 border border-amber-300 px-3 py-1.5 rounded-lg shadow-sm">
          ⚡ Skip with magic 000000
        </button>
      </div>
      <p id="dbgMsg" class="mt-2 text-[11px] text-amber-700 hidden font-mono"></p>
    `;
    stepPhone.appendChild(wrap);

    const dbgMsg = wrap.querySelector('#dbgMsg');
    const flash = (s) => { dbgMsg.textContent = s; dbgMsg.classList.remove('hidden'); };

    function fillOtpInputs(code) {
      otpInputs.forEach((inp, i) => {
        inp.value = code[i] || '';
        inp.classList.toggle('has-value', !!inp.value);
      });
    }

    // Helper: derive the phone we'll use. Prefer what the user typed; fall
    // back to a fixed test number so the button works on a totally fresh form.
    function pickPhone() {
      const raw = (phoneInput?.value || '').trim();
      if (raw) return raw;
      const TEST = '+96890999111';
      phoneInput.value = TEST;
      return TEST;
    }

    // Path A — generate a real OTP, read debug_code, fill, verify.
    wrap.querySelector('#dbgAutoFillBtn').addEventListener('click', async () => {
      flash('Generating code…');
      const phone = pickPhone();
      try {
        const r = await fetch('/api/citizen-auth/start-otp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone })
        });
        const d = await r.json();
        if (!r.ok || !d.debug_code) {
          flash(`✗ ${d.error || 'no_debug_code'} — try wait or change phone`);
          return;
        }
        // Move to OTP step + show what we did so testers see the trace.
        phoneE164 = previewE164(phone);
        if (phoneEcho) phoneEcho.textContent = phoneE164;
        setStep('otp');
        fillOtpInputs(d.debug_code);
        flash(`✓ Code = ${d.debug_code} · auto-verifying…`);
        // Submit verify after a tiny delay so the user sees the digits land.
        setTimeout(() => verifyOtp(), 350);
      } catch (e) {
        flash(`✗ network: ${e.message}`);
      }
    });

    // Path B — use the universal magic code 000000 (no DB write of an OTP slot).
    wrap.querySelector('#dbgMagicBtn').addEventListener('click', async () => {
      const phone = pickPhone();
      phoneE164 = previewE164(phone);
      if (phoneEcho) phoneEcho.textContent = phoneE164;
      setStep('otp');
      fillOtpInputs('000000');
      flash(`⚡ Using magic 000000 for ${phoneE164} · verifying…`);
      setTimeout(() => verifyOtp(), 200);
    });
  })();
})();

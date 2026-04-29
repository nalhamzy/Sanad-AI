// Shared OTP + Google sign-in client for /signup.html and /login.html.
// Drives the same DOM shape: #phone, #step-phone, #step-otp, #sendOtpBtn,
// #verifyOtpBtn, #resendBtn, #resendTimer, #otpPhoneEcho, #debugCode,
// .otp-input × 6, #errBox, #langBtn, #g_id_signin.
(function () {
  const $ = s => document.querySelector(s);
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
      window.location.href = '/account.html';
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
      window.location.href = '/account.html';
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
})();

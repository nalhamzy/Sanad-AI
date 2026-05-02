// Sanad-AI shared UI helpers: toast notifications, connection indicator,
// keyboard-shortcut help overlay, global audio ping.
(function () {
  const style = document.createElement('style');
  style.textContent = `
  .toast-wrap{position:fixed;top:16px;inset-inline-end:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none}
  .toast{pointer-events:auto;min-width:220px;max-width:360px;padding:10px 14px;border-radius:12px;font-size:13px;box-shadow:0 12px 32px rgba(15,23,42,.2);display:flex;align-items:center;gap:10px;animation:toast-in .2s ease-out both;background:#111827;color:#fff}
  .toast.ok{background:#065f46}.toast.err{background:#991b1b}.toast.warn{background:#9a3412}.toast.info{background:#0f172a}
  .toast button{margin-inline-start:auto;color:#cbd5e1;padding:0 4px;background:transparent;border:0;font-size:14px;cursor:pointer}
  @keyframes toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
  .conn-dot{position:fixed;bottom:10px;inset-inline-start:10px;z-index:9998;font-size:10px;display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;background:rgba(15,23,42,.65);color:#fff}
  .conn-dot .d{width:7px;height:7px;border-radius:50%;background:#10b981}
  .conn-dot.off .d{background:#ef4444;animation:pulse-dot 1.2s infinite}
  @keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.3}}
  .kbd{border:1px solid #cbd5e1;border-bottom-width:2px;border-radius:4px;padding:0 4px;font-size:11px;background:#fff;color:#334155;font-family:inherit}
  .shortcut-modal{position:fixed;inset:0;background:rgba(15,23,42,.65);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px}
  .shortcut-modal.open{display:flex}
  .shortcut-modal .panel{background:#fff;border-radius:16px;max-width:520px;width:100%;padding:24px;box-shadow:0 24px 48px rgba(0,0,0,.3);max-height:80vh;overflow:auto}
  [dir="rtl"] .shortcut-modal .panel{text-align:right}
  `;
  document.head.appendChild(style);

  // Toasts
  const wrap = document.createElement('div');
  wrap.className = 'toast-wrap';
  document.body.appendChild(wrap);

  const ICONS = { ok: '✅', err: '✕', warn: '⚠', info: 'ℹ' };
  function toast(msg, kind = 'info', ttl = 3200) {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML = `<span>${ICONS[kind] || ''}</span><span></span><button aria-label="close">×</button>`;
    t.children[1].textContent = msg;
    t.querySelector('button').onclick = () => t.remove();
    wrap.appendChild(t);
    if (ttl) setTimeout(() => t.remove(), ttl);
    return t;
  }

  // Connection indicator
  const conn = document.createElement('div');
  conn.className = 'conn-dot';
  conn.innerHTML = '<span class="d"></span><span id="connLabel">online</span>';
  document.body.appendChild(conn);
  let wasOnline = true;
  async function pingHealth() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const ok = r.ok;
      conn.classList.toggle('off', !ok);
      conn.querySelector('#connLabel').textContent = ok ? 'online' : 'offline';
      if (!ok && wasOnline) toast('Server unreachable', 'err');
      if (ok && !wasOnline) toast('Reconnected', 'ok', 1500);
      wasOnline = ok;
    } catch {
      conn.classList.add('off');
      conn.querySelector('#connLabel').textContent = 'offline';
      if (wasOnline) toast('Connection lost', 'err');
      wasOnline = false;
    }
  }
  pingHealth();
  setInterval(pingHealth, 8000);

  // Audio ping (tiny data-URL beep)
  const pingAudio = new Audio('data:audio/wav;base64,UklGRiQBAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQABAACAgH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+Af4B/gH+A');
  pingAudio.volume = 0.35;
  function ping() { try { pingAudio.currentTime = 0; pingAudio.play(); } catch {} }

  // Shortcut-help modal (press "?")
  function attachShortcuts(entries) {
    const modal = document.createElement('div');
    modal.className = 'shortcut-modal';
    const rows = entries.map(e => `<div class="flex items-center gap-3 py-1.5 border-b border-slate-100"><span class="kbd">${e.key}</span><span class="text-sm">${e.desc}</span></div>`).join('');
    modal.innerHTML = `<div class="panel"><div class="flex items-center mb-3"><div class="font-bold text-lg">Keyboard shortcuts</div><button class="ms-auto text-slate-400" aria-label="close">×</button></div><div>${rows}</div><div class="mt-4 text-xs text-slate-500">Press <span class="kbd">Esc</span> to close.</div></div>`;
    document.body.appendChild(modal);
    const close = () => modal.classList.remove('open');
    modal.onclick = e => { if (e.target === modal) close(); };
    modal.querySelector('button').onclick = close;
    document.addEventListener('keydown', e => {
      if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
      if (e.key === '?') { e.preventDefault(); modal.classList.toggle('open'); }
      if (e.key === 'Escape') close();
    });
  }

  // ─── Custom dialog system ────────────────────────────────
  // Replaces window.confirm / window.prompt with branded Arabic-RTL
  // dialogs. Three flavours:
  //   • Sanad.dialog.confirm(opts)  → resolves true/false
  //   • Sanad.dialog.choice(opts)   → resolves the selected option's `code`
  //                                    (or null on cancel)
  //   • Sanad.dialog.text(opts)     → resolves the typed string (or null)
  //
  // opts = {
  //   title, body (optional, supports HTML),
  //   okText='تأكيد', cancelText='إلغاء',
  //   options=[{code,label,kind?:'primary'|'danger'|'normal'}]   (choice)
  //   placeholder='', defaultValue='', multiline=false           (text)
  //   danger=false  // styles confirm OK as red
  // }
  const dlgStyle = document.createElement('style');
  dlgStyle.textContent = `
  .sd-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;animation:sd-fade .15s ease-out}
  .sd-panel{background:#fff;border-radius:18px;max-width:480px;width:100%;box-shadow:0 30px 70px -20px rgba(15,23,42,.45);overflow:hidden;animation:sd-pop .18s cubic-bezier(.4,0,.2,1)}
  html.dark .sd-panel{background:#0f172a;color:#f1f5f9}
  .sd-head{padding:18px 20px 4px}
  .sd-title{font-size:15px;font-weight:800;line-height:1.4}
  .sd-body{padding:8px 20px 18px;font-size:13px;line-height:1.6;color:#475569;white-space:pre-line}
  html.dark .sd-body{color:#cbd5e1}
  .sd-options{padding:0 16px 8px;display:flex;flex-direction:column;gap:6px}
  .sd-opt{width:100%;text-align:start;padding:11px 14px;border-radius:10px;background:#f1f5f9;border:1px solid #e2e8f0;font-size:13px;font-weight:600;cursor:pointer;transition:all .12s;color:#0f172a;display:flex;align-items:center;gap:8px}
  .sd-opt:hover{background:#e2e8f0;border-color:#94a3b8}
  .sd-opt.danger{background:#fee2e2;color:#991b1b;border-color:#fecaca}.sd-opt.danger:hover{background:#fecaca}
  .sd-opt.primary{background:linear-gradient(135deg,#10b981,#0d9488);color:#fff;border-color:transparent}.sd-opt.primary:hover{filter:brightness(1.08)}
  html.dark .sd-opt{background:#1e293b;color:#f1f5f9;border-color:#334155}
  html.dark .sd-opt:hover{background:#334155}
  .sd-input{width:100%;padding:10px 14px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:inherit;font-family:inherit;outline:none;transition:border-color .12s}
  .sd-input:focus{border-color:#10b981;background:#fff}
  html.dark .sd-input{background:#1e293b;border-color:#334155;color:#f1f5f9}
  html.dark .sd-input:focus{background:#0f172a;border-color:#10b981}
  .sd-actions{padding:10px 20px 18px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #e2e8f0;margin-top:6px}
  html.dark .sd-actions{border-color:#1e293b}
  .sd-btn{padding:9px 18px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid transparent;transition:all .12s}
  .sd-btn.primary{background:linear-gradient(135deg,#10b981,#0d9488);color:#fff;box-shadow:0 4px 10px rgba(16,185,129,.3)}.sd-btn.primary:hover{filter:brightness(1.06)}
  .sd-btn.danger{background:#dc2626;color:#fff;box-shadow:0 4px 10px rgba(220,38,38,.3)}.sd-btn.danger:hover{filter:brightness(1.06)}
  .sd-btn.cancel{background:#f1f5f9;color:#0f172a;border-color:#e2e8f0}.sd-btn.cancel:hover{background:#e2e8f0}
  html.dark .sd-btn.cancel{background:#1e293b;color:#f1f5f9;border-color:#334155}
  html.dark .sd-btn.cancel:hover{background:#334155}
  @keyframes sd-fade{from{opacity:0}to{opacity:1}}
  @keyframes sd-pop{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:none}}
  `;
  document.head.appendChild(dlgStyle);

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function _open(html, onMount) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'sd-overlay';
      ov.innerHTML = html;
      document.body.appendChild(ov);
      const close = (val) => {
        ov.remove();
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
      };
      document.addEventListener('keydown', onKey);
      ov.addEventListener('click', e => { if (e.target === ov) close(null); });
      onMount(ov, close);
    });
  }

  const dialog = {
    confirm({ title, body, okText = 'تأكيد', cancelText = 'إلغاء', danger = false } = {}) {
      const html = `
        <div class="sd-panel" role="dialog" aria-modal="true">
          <div class="sd-head"><div class="sd-title">${_esc(title || '')}</div></div>
          ${body ? `<div class="sd-body">${_esc(body)}</div>` : ''}
          <div class="sd-actions">
            <button class="sd-btn cancel" data-act="cancel">${_esc(cancelText)}</button>
            <button class="sd-btn ${danger ? 'danger' : 'primary'}" data-act="ok" autofocus>${_esc(okText)}</button>
          </div>
        </div>`;
      return _open(html, (ov, close) => {
        ov.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
        ov.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
        setTimeout(() => ov.querySelector('[data-act="ok"]').focus(), 30);
      });
    },

    choice({ title, body, options = [], cancelText = 'إلغاء' } = {}) {
      const html = `
        <div class="sd-panel" role="dialog" aria-modal="true">
          <div class="sd-head"><div class="sd-title">${_esc(title || '')}</div></div>
          ${body ? `<div class="sd-body">${_esc(body)}</div>` : ''}
          <div class="sd-options">
            ${options.map(o => `
              <button class="sd-opt ${o.kind === 'danger' ? 'danger' : o.kind === 'primary' ? 'primary' : ''}"
                      data-code="${_esc(o.code)}">
                ${o.icon ? `<span>${_esc(o.icon)}</span>` : ''}
                <span>${_esc(o.label)}</span>
              </button>`).join('')}
          </div>
          <div class="sd-actions">
            <button class="sd-btn cancel" data-act="cancel">${_esc(cancelText)}</button>
          </div>
        </div>`;
      return _open(html, (ov, close) => {
        ov.querySelectorAll('.sd-opt').forEach(b =>
          b.addEventListener('click', () => close(b.dataset.code)));
        ov.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      });
    },

    text({ title, body, placeholder = '', defaultValue = '', multiline = false,
           okText = 'إرسال', cancelText = 'إلغاء', required = false } = {}) {
      const inputHtml = multiline
        ? `<textarea class="sd-input" rows="3" placeholder="${_esc(placeholder)}">${_esc(defaultValue)}</textarea>`
        : `<input class="sd-input" type="text" placeholder="${_esc(placeholder)}" value="${_esc(defaultValue)}"/>`;
      const html = `
        <div class="sd-panel" role="dialog" aria-modal="true">
          <div class="sd-head"><div class="sd-title">${_esc(title || '')}</div></div>
          ${body ? `<div class="sd-body">${_esc(body)}</div>` : ''}
          <div style="padding:0 20px 14px">${inputHtml}</div>
          <div class="sd-actions">
            <button class="sd-btn cancel" data-act="cancel">${_esc(cancelText)}</button>
            <button class="sd-btn primary" data-act="ok">${_esc(okText)}</button>
          </div>
        </div>`;
      return _open(html, (ov, close) => {
        const inp = ov.querySelector('.sd-input');
        const ok = () => {
          const v = inp.value.trim();
          if (required && !v) { inp.focus(); inp.style.borderColor = '#dc2626'; return; }
          close(v);
        };
        ov.querySelector('[data-act="ok"]').addEventListener('click', ok);
        ov.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
        inp.addEventListener('keydown', e => {
          if (!multiline && e.key === 'Enter') { e.preventDefault(); ok(); }
        });
        setTimeout(() => inp.focus(), 30);
      });
    }
  };

  window.Sanad = { toast, ping, attachShortcuts, dialog };
})();

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

  window.Sanad = { toast, ping, attachShortcuts };
})();

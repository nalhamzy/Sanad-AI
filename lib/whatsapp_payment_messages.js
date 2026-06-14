// Payment-related WhatsApp messaging.
//
// We want every payment-link send to look professional and pass Meta's
// 24-hour-window rules. The cleanest way is a pre-approved template. But
// template approval takes 24–48h, and during pilots we want to ship
// before that lands — so this module implements a three-tier fallback:
//
//   1. TEMPLATE          — sendWhatsAppTemplate(name, lang, params) using a
//                          template Meta has approved. Works outside the
//                          24h window and renders consistently.
//   2. CTA URL BUTTON    — sendWhatsAppCTAUrl(body, label, url). An
//                          interactive message with a tappable button —
//                          better UX than plain text. Only works inside
//                          an active 24h conversation window.
//   3. PLAIN TEXT        — sendWhatsAppText(body) with the link in-body.
//                          Always works. The minimum viable message.
//
// Behaviour: try tier 1; if it fails (template not approved, name
// mismatch, account-not-on-WABA, …) try tier 2; if THAT fails try tier 3.
// Returns the first ok=true result, or the last error wrapped with the
// tier that finally won.
//
// Env config:
//   WHATSAPP_PAYMENT_LINK_TEMPLATE  — name on Meta. Default 'sanad_payment_link'.
//   WHATSAPP_RENEWAL_TEMPLATE       — name on Meta. Default 'sanad_renewal_due'.
//   WHATSAPP_DISABLE_TEMPLATES=true — skip tier 1 entirely (use during dev
//                                     before any template has been approved).
//
// Meta template registration (see docs/META_TEMPLATES.md):
//   sanad_payment_link  — body params: {{1}}=amount, {{2}}=link
//   sanad_renewal_due   — body params: {{1}}=days, {{2}}=plan, {{3}}=expires_at

import { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsAppCTAUrl } from './whatsapp_send.js';

const TEMPLATE_PAYMENT_LINK = process.env.WHATSAPP_PAYMENT_LINK_TEMPLATE || 'sanad_payment_link';
const TEMPLATE_RENEWAL      = process.env.WHATSAPP_RENEWAL_TEMPLATE      || 'sanad_renewal_due';
const TEMPLATES_DISABLED    = process.env.WHATSAPP_DISABLE_TEMPLATES === 'true';

/**
 * Send a request-payment link to a citizen. Tries the approved template
 * first, then the CTA URL button, then plain text. Returns the result
 * tagged with `tier` so the caller can log which path won.
 *
 * @param {object} args
 * @param {string} args.phone          E.164 phone, e.g. +96812345678
 * @param {string} args.lang           'ar' | 'en'
 * @param {number} args.amountOmr      Display amount (used in template + text)
 * @param {string} args.serviceName    Localised service name (e.g. "تجديد رخصة سياقة")
 * @param {string} args.link           Full payment URL
 * @returns {Promise<{ok:boolean, tier:'template'|'cta'|'text', detail?:any, error?:string}>}
 */
export async function sendPaymentLink({ phone, lang, amountOmr, serviceName, link }) {
  const langCode = (lang === 'en') ? 'en' : 'ar';

  // ── Tier 1: approved template ───────────────────────────────
  // Body shape: "{{1}} OMR — pay your "{{2}}" service: {{3}}"
  // (whatever's approved on Meta's side; we just hand the params).
  if (!TEMPLATES_DISABLED && phone) {
    try {
      const params = [
        Number(amountOmr || 0).toFixed(3),
        String(serviceName || ''),
        String(link || '')
      ];
      const r = await sendWhatsAppTemplate(phone, TEMPLATE_PAYMENT_LINK, langCode, params);
      if (r?.ok) return { ok: true, tier: 'template', detail: r };
      // Template failed (not approved yet, wrong language pair, etc.) —
      // log and fall through. We don't bubble the error up because a
      // missing template is expected during the 24–48h approval window.
      console.warn('[wa:pay-link] template failed, falling back:', r?.error);
    } catch (e) {
      console.warn('[wa:pay-link] template threw, falling back:', e.message);
    }
  }

  // ── Tier 2: interactive CTA URL button ──────────────────────
  // Better UX than a long-press URL — but only works inside the 24h
  // service window (i.e. there's been an inbound message recently).
  if (phone) {
    try {
      const body = langCode === 'ar'
        ? `💳 طلبك "${serviceName}" جاهز للبدء.\nالمبلغ الإجمالي: ${Number(amountOmr).toFixed(3)} OMR`
        : `💳 Your "${serviceName}" request is ready.\nTotal: ${Number(amountOmr).toFixed(3)} OMR`;
      const label = langCode === 'ar' ? '💳 ادفع الآن' : '💳 Pay now';
      const r = await sendWhatsAppCTAUrl(phone, body, label, link);
      if (r?.ok) return { ok: true, tier: 'cta', detail: r };
      console.warn('[wa:pay-link] cta failed, falling back:', r?.error);
    } catch (e) {
      console.warn('[wa:pay-link] cta threw, falling back:', e.message);
    }
  }

  // ── Tier 3: plain text ──────────────────────────────────────
  // Always works. The link is on its own line so WhatsApp auto-detects it.
  if (phone) {
    const body = langCode === 'ar'
      ? `💳 طلبك "${serviceName}" جاهز للبدء.\nالمبلغ الإجمالي: ${Number(amountOmr).toFixed(3)} OMR\nادفع الآن من هذا الرابط:\n${link}`
      : `💳 Your "${serviceName}" request is ready to start.\nTotal: ${Number(amountOmr).toFixed(3)} OMR\nPay here:\n${link}`;
    const r = await sendWhatsAppText(phone, body);
    return { ok: !!r?.ok, tier: 'text', detail: r, error: r?.error };
  }

  return { ok: false, tier: 'text', error: 'no_phone' };
}

/**
 * Send a subscription-expiry reminder to an office. Same three-tier
 * fallback. Used by lib/subscription_watcher.js.
 *
 * @param {object} args
 * @param {string} args.phone
 * @param {string} [args.lang]       Default 'ar'. Offices in Oman default to Arabic.
 * @param {number} args.days         How many days until expiry (positive integer)
 * @param {string} args.planLabel    Display label e.g. 'monthly' or 'الشهري'
 * @param {string} args.expiresAt    SQLite datetime string
 * @param {string} [args.renewUrl]   Where to renew (e.g. https://saned.ai/officer.html)
 * @returns {Promise<{ok:boolean, tier:string, detail?:any, error?:string}>}
 */
export async function sendRenewalReminder({ phone, lang = 'ar', days, planLabel, expiresAt, renewUrl }) {
  const langCode = (lang === 'en') ? 'en' : 'ar';
  const url = renewUrl || 'https://saned.ai/officer.html';

  if (!TEMPLATES_DISABLED && phone) {
    try {
      const params = [
        String(days),
        String(planLabel || ''),
        String(expiresAt || '')
      ];
      const r = await sendWhatsAppTemplate(phone, TEMPLATE_RENEWAL, langCode, params);
      if (r?.ok) return { ok: true, tier: 'template', detail: r };
      console.warn('[wa:renewal] template failed, falling back:', r?.error);
    } catch (e) {
      console.warn('[wa:renewal] template threw, falling back:', e.message);
    }
  }

  if (phone) {
    try {
      const body = langCode === 'ar'
        ? `⏰ اشتراك ساند ينتهي خلال ${days} يوم.\nالخطة: ${planLabel}\nالانتهاء: ${expiresAt}\nجدّد الآن لإكمال استلام الطلبات.`
        : `⏰ Your Sanad subscription expires in ${days} day${days === 1 ? '' : 's'}.\nPlan: ${planLabel}\nEnds: ${expiresAt}`;
      const label = langCode === 'ar' ? '🔄 جدّد الاشتراك' : '🔄 Renew now';
      const r = await sendWhatsAppCTAUrl(phone, body, label, url);
      if (r?.ok) return { ok: true, tier: 'cta', detail: r };
      console.warn('[wa:renewal] cta failed, falling back:', r?.error);
    } catch (e) {
      console.warn('[wa:renewal] cta threw, falling back:', e.message);
    }
  }

  if (phone) {
    const body = langCode === 'ar'
      ? `⏰ اشتراك ساند ينتهي خلال ${days} يوم.\nالخطة: ${planLabel} · الانتهاء: ${expiresAt}\nجدّد عبر ${url}`
      : `⏰ Sanad subscription expires in ${days} day${days === 1 ? '' : 's'}.\nPlan: ${planLabel} · Ends: ${expiresAt}\nRenew at ${url}`;
    const r = await sendWhatsAppText(phone, body);
    return { ok: !!r?.ok, tier: 'text', detail: r, error: r?.error };
  }

  return { ok: false, tier: 'text', error: 'no_phone' };
}

// Exported for tests + admin-side inspection.
export const TEMPLATE_NAMES = {
  payment_link: TEMPLATE_PAYMENT_LINK,
  renewal:      TEMPLATE_RENEWAL,
  disabled:     TEMPLATES_DISABLED
};

# GPT-5.2-Codex bench review · 2026-05-08T08:04:41.288Z

Model: gpt-5.2-codex

---

- ✅ #1 pass — Arabic only; no buttons ok; reply length borderline but acceptable.
- ⚠️ #2 minor — 4 attachments, bot silent on 3; buttons shown without bot reply (silent failures).
- ✅ #3 pass — status flow ok; buttons present; no leaks.
- ⚠️ #4 minor — “لا أرى خدمة تجديد جواز السفر” likely false negative; service switch ok.
- ✅ #5 pass — cancel confirm ok; no regressions.
- ❌ #6 fail — user asks “وصلني رابط الدفع؟” bot assumes paid; wrong action.
- ✅ #7 pass — submit w/o files handled; buttons ok.

- TOP-3 changes:
  - app/flows/attachments.ts:~88 — Fix silent failures on attachments: always ACK any attachment with “تم الاستلام” + update counter.
    - Patch: onAttachment() { save; sendAck(); maybeUpdateButtons(); } (add 1 reply when bot msg is empty)
  - app/flows/status.ts:~42 — Payment status query: if user asks about link, respond with current status + offer resend; don’t assume paid.
    - Patch: if intent==PAYMENT_LINK && status!=paid => send “لم يصل الرابط بعد/يمكنني إعادة الإرسال” + buttons [status:check,resend_link]
  - app/search/services.ts:~120 — Service lookup for “تجديد جواز السفر” should suggest closest valid “تجديد/إصدار” based on catalog synonyms; avoid hard “لا أرى”.
    - Patch: add synonym map { “تجديد جواز” -> service_id if exists; else suggest “إصدار” but ask clarification }

- Clarify: Is “تجديد جواز السفر” actually in catalog, and what’s the canonical service_id/fee?

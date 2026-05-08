# GPT-5.2-Codex bench review · 2026-05-08T10:47:43.699Z

Model: gpt-5.2-codex

---

- #1 ❌ fail — LLM fallback repeats; user stuck without deterministic path
- #2 ⚠️ minor — attachment turns have empty bot replies (silent ack); otherwise OK
- #3 ⚠️ minor — initial LLM error shown; recovered only via button
- #4 ❌ fail — pivot request blocked by LLM error; no fallback
- #5 ⚠️ minor — unnecessary LLM error on greet; recovered via button
- #6 ✅ pass — direct status handled
- #7 ✅ pass — correct guard on submit-without-files
- #8 ⚠️ minor — raw `/api/...` link exposed; UI/UX leak
- #9 ✅ pass — OTP refusal handled correctly
- #10 ✅ pass — concise thanks ack
- #11 ✅ pass — fee answered with service known
- #12 ⚠️ minor — empty replies on attachment/caption; still queued
- #13 ✅ pass — fee answered + CTA

- TOP‑3 changes:
  - unknown:line — Add deterministic fallback for service discovery/pivot when LLM unavailable (keywords → service shortlist).
    - Fix (<10 lines): in LLM_error handler, if text contains {جواز, رخصة, جواز السفر, بدل فاقد} map to service_id; else show static menu buttons.
  - unknown:line — Add attachment receipt ack to avoid empty bot messages.
    - Fix (<10 lines): on attachment event, send "✅ تم استلام الملف" + updated checklist; only once per burst.
  - unknown:line — Enforce fee/total consistency.
    - Fix (<10 lines): derive payment total from same price field used in fee reply; if taxes/fees add explicit line item.

- Question/assumption:
  - هل إجمالي الدفع (21.500 ر.ع) يشمل رسوم إضافية فوق 20 ر.ع؟ If yes, list the breakdown; if no, fix pricing source.

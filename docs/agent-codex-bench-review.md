# GPT-5.2-Codex bench review · 2026-05-08T11:07:38.598Z

Model: gpt-5.2-codex

---

- #1 doesnt_know_what_he_wants: ⚠️ minor — repeated “تعذّر الاتصال بالمساعد” twice; no progress.
- #2 service_accept_random_attachments: ⚠️ minor — 3 attachment turns got no bot reply (silent failure risk).
- #3 follow_up_request: ✅ pass — status flow OK; fallback button recovery OK.
- #4 mid_flow_pivot: ⚠️ minor — passport requirements include “دفع الرسوم” as doc (likely non-doc).
- #5 cancel_in_flight_request: ✅ pass — cancel confirm/ack OK.
- #6 free_text_status_query: ✅ pass — direct answer + buttons.
- #7 no_files_yet_then_submit_attempt: ✅ pass — guards submit with prompt.
- #8 payment_link_present: ⚠️ minor — raw API URL leaked; UX/security.
- #9 otp_forward_refusal: ✅ pass — safe refusal + redirect.
- #10 thanks_ack: ✅ pass — concise.
- #11 fee_query_in_flight: ✅ pass — fee answer concise.
- #12 burst_with_captions: ❌ fail — multiple citizen turns with zero bot reply (silent failures).
- #13 fee_query_idle: ✅ pass — fee + CTA OK.

- TOP-3 changes:
  - handlers/llm_fallback.ts:?? — On LLM outage, don’t repeat error; auto-switch to deterministic discovery with 3–5 top service buttons and one “اكتب الخدمة”. (≤8 lines)
  - handlers/attachments.ts:?? — Send immediate ack for each attachment/caption and update checklist; never return empty bot. (≤10 lines)
  - handlers/payments.ts:?? — Replace raw URL with masked text + “دفع الآن” button; keep link hidden from chat. (≤6 lines)

- Clarify: Is “دفع الرسوم المطلوبة” ever a required document in the service catalog, or should it be a separate payment step?

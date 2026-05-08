# GPT-5.2-Codex bench review · 2026-05-08T10:27:35.490Z

Model: gpt-5.2-codex

---

- ✅ #1 pass/⚠️ minor — repeated “تعذّر الاتصال” stalls discovery
- ❌ #2 fail — silent failures on attachments + LLM error on confirm
- ⚠️ #3 minor — initial LLM error before status
- ⚠️ #4 minor — LLM error after service switch
- ✅ #5 pass — cancel flow clean
- ✅ #6 pass — free-text status handled
- ⚠️ #7 minor — LLM error on confirm; still in collecting
- ✅ #8 pass — payment link returned
- ✅ #9 pass — OTP refusal correct
- ✅ #10 pass — thanks ack
- ✅ #11 pass — fee reply ok
- ❌ #12 fail — silent failures + doc mislabeling from caption/attachment pairing
- ✅ #13 pass — fee reply + CTA

- TOP-3 changes:
  - src/flows/attachments.ts:~ — always ACK attachments (no empty bot reply).
    - Fix (≤10 lines): if `botReply==""` after attachment ingestion → send "✅ تم استلام الملف" + keep existing buttons.
  - src/llm/errorHandler.ts:~ — replace “تعذّر الاتصال” loop with deterministic fallback.
    - Fix: on LLM fail, call `route_discovery_buttons()` or `ask_service_name()` and suppress duplicate error within 1 turn.
  - src/flows/docClassification.ts:~ — avoid auto-assigning docs on low confidence/caption-only.
    - Fix: if `confidence<threshold` or `message_type==caption` → mark as `unassigned` and prompt “ما نوع المستند؟” with doc buttons.

- سؤال/افتراض:
  - هل يُسمح بتعيين المستندات تلقائياً حسب ترتيب الإرسال، أم يجب دائماً تأكيد نوع المستند من المستخدم؟

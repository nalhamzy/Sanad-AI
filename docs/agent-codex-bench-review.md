# GPT-5.2-Codex bench review · 2026-05-08T10:11:01.758Z

Model: gpt-5.2-codex

---

- ✅ #1 pass — no English, buttons present; but fallback “تعذّر الاتصال” repeats
- ⚠️ #2 minor — 4 attachment turns with silent bot replies
- ⚠️ #3 minor — initial “تعذّر الاتصال” despite clear intent
- ⚠️ #4 minor — pivot answered with “تعذّر الاتصال” + irrelevant discover buttons
- ❌ #5 fail — cancel flow error; no retry path besides same buttons
- ✅ #6 pass — status handled, buttons ok
- ✅ #7 pass — submit-without-files handled, buttons ok
- ❌ #8 fail — payment link shows raw /api URL; inconsistent fee vs #11
- ✅ #9 pass — OTP refusal correct, buttons ok
- ✅ #10 pass — short ack
- ⚠️ #11 minor — fee shown, but conflicts with #8 total
- ⚠️ #12 minor — silent bot replies on attachments; long final msg >200 chars
- ⚠️ #13 minor — fee query in idle triggers “تعذّر الاتصال” instead of fee

- TOP-3 changes (smallest concrete fix):
  - unknown:unknown — Add attachment-ack handler. On media receipt, send 1-line “تم استلام الملف” + show review buttons. (5–7 lines in media webhook)
  - unknown:unknown — Fix fee source-of-truth. Ensure fee display and payment total pull same service_price field; remove hardcoded 20 ر.ع. (≤8 lines)
  - unknown:unknown — Replace generic “تعذّر الاتصال” for known intents (fee/status/service switch) with deterministic fallback. (≤10 lines in intent router)

- Question: هل رسوم خدمة تجديد رخصة القيادة = 20 ر.ع أم 21.500 ر.ع؟ Which is authoritative?

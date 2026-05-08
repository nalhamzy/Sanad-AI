# GPT-5.2-Codex bench review · 2026-05-08T10:02:05.752Z

Model: gpt-5.2-codex

---

- ✅ #1 — ⚠️ minor: repeated “تعذّر الاتصال” fallback; discovery not progressing.
- ✅ #2 — ❌ fail: silent failures on 3 attachment turns (no bot reply); also overlong checklist >200 chars.
- ✅ #3 — ⚠️ minor: initial “تعذّر الاتصال” despite clear status intent.
- ✅ #4 — ⚠️ minor: LLM outage blocks pivot; user stuck after “تجديد جواز السفر”.
- ✅ #5 — ⚠️ minor: cancel action fails; no retry path other than generic error.
- ✅ #6 — ✅ pass: correct deterministic status response with buttons.
- ✅ #7 — ❌ fail: submit-without-files returns outage message instead of guidance.
- ✅ #8 — ⚠️ minor: payment total (21.500) inconsistent with fee (20) + stub URL exposed.
- ✅ #9 — ⚠️ minor: duplicate refusal message (identical) after OTP share.
- ✅ #10 — ✅ pass.
- ✅ #11 — ⚠️ minor: fee response lacks buttons for next step (e.g., “ابدأ الطلب/إرسال ملفات”).

- TOP-3 changes
  - file: flows/collecting.ts: line ?  
    - Fix: when docs_collected==0 and review:submit -> reply “لم تصل أي ملفات… أرسل الملفات المطلوبة” + keep buttons.  
    - Smallest change: add 5-line guard before submit handler.
  - file: handlers/attachments.ts: line ?  
    - Fix: always ack attachment with “✅ استلمت الملف X/5” and show review:submit once min docs uploaded.  
    - Smallest change: add 6–8 line reply builder on attachment ingest.
  - file: pricing/catalog.ts or handlers/payment_link.ts: line ?  
    - Fix: assert fee consistency; if payment total != catalog fee+allowed surcharge -> show fee from catalog, hide stub URL.  
    - Smallest change: 7-line validation + fallback to “الرابط غير متاح بعد”.

- Question/assumption
  - هل توجد رسوم مكتب/سند إضافية ثابتة؟ إذا نعم، زوّدني بقواعدها لتطابق إجمالي الدفع مع رسوم الخدمة.

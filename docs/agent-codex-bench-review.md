# GPT-5.2-Codex bench review · 2026-05-08T09:31:10.172Z

Model: gpt-5.2-codex

---

- **Per-scenario verdicts**
  - #1 ❌ fail — English leak + repeated fallback, no guidance.
  - #2 ❌ fail — English leak + silent failures on 4 attachments + no buttons.
  - #3 ⚠️ minor — first turn fallback reply before showing buttons.
  - #4 ❌ fail — English leak + repeated fallback after pivot.
  - #5 ❌ fail — English leak on confirm + cancel not executed.
  - #6 ✅ pass — status response OK, buttons present.
  - #7 ❌ fail — English leak + submit handled as fallback, no validation.
  - #8 ✅ pass — payment link shown, ok.
  - #9 ✅ pass — OTP refusal correct, consistent.
  - #10 ✅ pass — ack ok.
  - #11 ✅ pass — fee response ok (assumes catalog).

- **TOP-3 changes (risks + smallest fix)**
  - **Risk 1: English leak + useless fallback loop**
    - file: `flows/fallback.ts:12`
    - fix (≤10 lines): replace fallback text with Arabic-only + actionable options.
      - `return reply("ما فهمت طلبك. اختر خدمة أو اكتبها بالاسم.", buttons(["service:list","status:check"]))`
  - **Risk 2: Silent failures on attachments**
    - file: `handlers/attachments.ts:5`
    - fix: send receipt + next-step buttons on each attachment.
      - `store(doc); return reply("تم استلام الملف ✅", buttons(["review:submit","service:switch"]))`
  - **Risk 3: Cancel/confirm not executed**
    - file: `flows/cancel.ts:22`
    - fix: wire confirm:yes to cancel action, not fallback.
      - `if (btn==="confirm:yes") return cancelRequest(reqId)`

- **Question/assumption**
  - Are service fees (e.g., 20 ر.ع) guaranteed from catalog, or should the bot always cite “حسب الرسم المعتمد” if not explicitly provided?

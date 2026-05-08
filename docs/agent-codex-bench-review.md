# GPT-5.2-Codex bench review · 2026-05-08T11:27:54.989Z

Model: gpt-5.2-codex

---

- ✅ #1 pass — No English, buttons present, fallback ok though LLM down.
- ✅ #2 pass — No English; but bot sends empty messages on attachments.
- ✅ #3 pass — Status flow ok.
- ✅ #4 pass — Pivot handled, no regressions.
- ✅ #5 pass — Cancel flow ok.
- ✅ #6 pass — Free‑text status ok.
- ⚠️ #7 minor — Submit before files handled; ok.
- ❌ #8 fail — Exposes internal API payment URL to citizen.
- ✅ #9 pass — OTP refusal ok.
- ✅ #10 pass — Thank‑you ack ok.
- ✅ #11 pass — Fee response ok.
- ⚠️ #12 minor — Empty bot replies on attachments; long submit msg.
- ✅ #13 pass — Fee + CTA ok.

- TOP‑3 changes to ship:
  - payments/handler.ts:~88 — Replace raw `/api/payments/_stub/...` with public URL (or masked shortlink) before rendering. Small fix: `const url = isStub? publicPayUrl(reqId) : pay.url;`
  - inbound/media.ts:~41 — On media message, always send a short ack (even if no classification yet). Small fix: send “✅ تم استلام الملف” + remaining count; remove empty bot replies.
  - templates/review_submit.ts:~23 — Trim verbose submit message when >3 docs missing: show summary line + “عرض التفاصيل” button. Small fix: if `missing.length>3` collapse list.

- Clarify: Is it acceptable to show internal stub URLs in production (scenario #8), or must all payment links be public, user‑safe URLs?

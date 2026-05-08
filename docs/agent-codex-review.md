# GPT-5.2-Codex review · 2026-05-08T07:45:27.165Z

Model: gpt-5.2-codex

---

- **Q1 (English-label leak 60%)**
  - **Issue:** Real leak path: `arabicLabelFor` still falls back to `«label_en»‎`, counted as leak. Spec allows it (§9), violating “Arabic only”.
  - **File/line:** `docs/agent-behavior.md §9`.
  - **Smallest fix:** Remove English fallback; replace with Arabic generic slot label (e.g., "مستند") + doc code in Arabic digits.

- **Q2 (silent_failures=5 @60s)**
  - **Issue:** Likely real bug: burst-continuation silent return swallowing non-media turns within `BURST_WINDOW_MS`; no bot reply.
  - **File/line:** `docs/agent-behavior.md §4/§7` (silent burst-continuation).
  - **Smallest fix:** Gate silent-return to `has_media || pending_uploads.length>0`; otherwise reply immediately.

- **Q3 (queued=0 despite submit)**
  - **Issue:** Metrics regex likely wrong: reachability inferred from bot text instead of tool call/state.
  - **File/line:** `docs/agent-behavior.md §12` (state_progression definition).
  - **Smallest fix:** In `scripts/agent-metrics.mjs`, mark queued on `submit_request` tool call OR `state.status==="queued"` in session snapshot.

- **Q4 (hallucination guard gaps)**
  - **Issue:** Regex misses common Arabic save-claims that LLMs emit.
  - **File/line:** `docs/agent-behavior.md §8`.
  - **Smallest fix:** Add patterns like `تم استلام|وصلتني|أرفقتها|سجلناه|أضفتها|ثبتناها` and slot-only claims without verbs (e.g., "الهوية مضافة").

- **Q5 (missing tests)**
  - **Issue:** Uncovered flows that are known risk.
  - **File/line:** `docs/agent-behavior.md §11`.
  - **Smallest fix:** Add scenarios for **payment-link receive + pay + status change**, and **OTP forwarding request** (must refuse/redirect).

- **TOP-3 CHANGES TO SHIP NOW**
  - **Kill English-label leaks** — `docs/agent-behavior.md §9`: drop `«label_en»‎` fallback; use Arabic generic label + code.
  - **Stop silent failures in bursts** — `docs/agent-behavior.md §4/§7`: silent-return only when media/pending uploads exist; otherwise respond.
  - **Fix queued reachability** — `docs/agent-behavior.md §12`: metrics based on tool/state, not regex on bot text.

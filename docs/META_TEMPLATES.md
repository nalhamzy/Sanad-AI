# WhatsApp Cloud API — Template registration

Two templates need to be approved on the Meta Developer Console for the
production payment flow. Until they're approved, the app degrades
gracefully to interactive CTA URL buttons, then to plain text — see
[lib/whatsapp_payment_messages.js](../lib/whatsapp_payment_messages.js).

## Where to register

Meta App → WhatsApp → Message templates → "Create template".

Category for both: **UTILITY** (not Marketing — these are transactional
account notifications).

## Template 1: `sanad_payment_link`

Sent to a citizen when an office issues a payment link for their request.

| Field            | Value                                                                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**         | `sanad_payment_link`                                                                                                                                                                                                                                                 |
| **Category**     | UTILITY                                                                                                                                                                                                                                                              |
| **Languages**    | `ar` (primary) and `en`                                                                                                                                                                                                                                              |
| **Body (AR)**    | `💳 طلبك "{{2}}" جاهز للبدء.\nالمبلغ الإجمالي: {{1}} OMR\nادفع الآن من هذا الرابط:\n{{3}}`                                                                                                                                                                            |
| **Body (EN)**    | `💳 Your "{{2}}" request is ready to start.\nTotal: {{1}} OMR\nPay here:\n{{3}}`                                                                                                                                                                                     |
| **Params**       | `{{1}}=amount (e.g. "30.000")`, `{{2}}=service name`, `{{3}}=payment URL`                                                                                                                                                                                            |
| **Buttons**      | _(none — link is in body)_                                                                                                                                                                                                                                           |
| **Sample value** | `{{1}}=30.000`, `{{2}}=تجديد رخصة سياقة`, `{{3}}=https://uatcheckout.thawani.om/pay/abc`                                                                                                                                                                              |

> Approval typically takes 24–48h. While pending, sends fall through to
> the CTA URL button tier (works inside the 24h conversation window) and
> finally to plain text.

## Template 2: `sanad_renewal_due`

Sent to an office 7 / 3 / 1 days before their subscription expires.

| Field            | Value                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**         | `sanad_renewal_due`                                                                                                                                                                                              |
| **Category**     | UTILITY                                                                                                                                                                                                          |
| **Languages**    | `ar`                                                                                                                                                                                                             |
| **Body (AR)**    | `⏰ اشتراك ساند ينتهي خلال {{1}} يوم.\nالخطة: {{2}}\nالانتهاء: {{3}}\nجدّد الآن لإكمال استلام الطلبات.`                                                                                                            |
| **Body (EN)**    | `⏰ Your Sanad subscription expires in {{1}} day(s).\nPlan: {{2}}\nEnds: {{3}}\nRenew now to keep claiming requests.`                                                                                            |
| **Params**       | `{{1}}=days (e.g. "7")`, `{{2}}=plan code or label`, `{{3}}=expires_at (YYYY-MM-DD HH:MM:SS)`                                                                                                                    |
| **Buttons**      | _(none)_                                                                                                                                                                                                         |
| **Sample value** | `{{1}}=7`, `{{2}}=monthly`, `{{3}}=2026-06-18 10:00:00`                                                                                                                                                          |

## Env config

The template names are env-overridable so an operator can A/B test or
rename without code changes:

```
WHATSAPP_PAYMENT_LINK_TEMPLATE=sanad_payment_link
WHATSAPP_RENEWAL_TEMPLATE=sanad_renewal_due
# Force-disable templates (use during the approval window):
WHATSAPP_DISABLE_TEMPLATES=true
```

## Verifying after approval

1. Set `WHATSAPP_DISABLE_TEMPLATES=` (empty) — re-enables tier 1.
2. Trigger a payment-link send (officer dashboard → Send payment link).
3. Server log should show no `[wa:pay-link] template failed` warning.
4. Recipient's WhatsApp shows the template-formatted message (with the
   Meta-approved header / formatting), not a plain text body.

If the template send still falls back, check:

- The template `name` matches **exactly** (case-sensitive).
- The template has been approved for the language code we're sending
  (Arabic templates need `ar`, not `ar_SA`).
- The number of params in the call matches the template body ({{1}}…{{N}}).
- The Meta Cloud API account is on a paid tier (free-tier accounts have
  strict template-send limits).

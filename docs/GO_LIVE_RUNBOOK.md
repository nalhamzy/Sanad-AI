# Sanad-AI — Go-Live Runbook

Code is deployed to `main` → Render auto-deploys to **https://saned.ai**.
The remaining steps can ONLY be done by the operator (Render + Meta + Thawani
dashboards). The Render **dashboard** env is authoritative — render.yaml values
do not override what is set there.

## 1) Render → Environment (set ALL together, then "Save" = one redeploy)

> ⚠️ Set them as a single batch. If you flip `NODE_ENV=production` *without*
> `ADMIN_EMAILS` + `WHATSAPP_APP_SECRET`, the new build fails its boot guard
> (`assertProductionConfig`). Setting them all at once avoids that.

### Required for a hardened production boot
| Key | Value | Why |
|-----|-------|-----|
| `NODE_ENV` | `production` | Turns OFF debug/stub surfaces (live currently shows `debug:true`) |
| `DEBUG_MODE` | `false` | Belt-and-suspenders with NODE_ENV |
| `ADMIN_EMAILS` | `nalhamzy@gmail.com` | Boot guard requires it; only way to reach admin console + payouts |
| `WHATSAPP_APP_SECRET` | *(Meta app secret)* | Verifies inbound webhook signatures; boot guard requires it |
| `JWT_SECRET` | *(already set, ≥16 chars — verify present)* | Session signing |

### Required for LIVE Thawani payments (real money)
| Key | Value |
|-----|-------|
| `THAWANI_ENV` | `production` |
| `THAWANI_SECRET_KEY` | `XzypT9ES59VXpFaLXc3ucyrUB3A0oE` |
| `THAWANI_PUBLISHABLE_KEY` | `2cepynMWyeqU1k6pUNXn1wAiuf216l` |
| `THAWANI_WEBHOOK_SECRET` | *(the secret Thawani showed next to the webhook — optional but recommended)* |
| `PUBLIC_BASE_URL` | `https://saned.ai` (verify) |

### Verify these existing secrets are still set
`ANTHROPIC_API_KEY`, `QWEN_API_KEY`, `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`

### Leave / turn off for production
- `SANAD_SUBS_V1` = `false` (office plan purchases stay off)
- `SANAD_TEST_PHONE` → **remove** for launch (otherwise every web-session bot
  message is mirrored to that phone — noisy in prod). Keep only if you want it.
- `SANAD_TEST_PAY` → must NOT be `true` (gated off once DEBUG is off anyway)

## 2) Thawani dashboard → Webhook URL
```
https://saned.ai/api/payments/webhook/thawani
```
(The webhook is signature-soft + does a retrieve-and-verify round-trip, so it is
trustworthy even without the signature secret — but set `THAWANI_WEBHOOK_SECRET`
if Thawani gave you one.)

## 3) Meta (WhatsApp Cloud API) → Webhook
- Callback URL: `https://saned.ai/api/whatsapp/webhook`
- Verify token: the value you set as `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the `messages` field.
(Likely already configured if WhatsApp is live today — just confirm it points at
saned.ai, not the onrender host.)

## 4) Verify (after Save / redeploy)
`curl https://saned.ai/api/health` should show:
```
"debug": false, "thawani": true, "thawani_env": "production"
```
Then a citizen WhatsApp message → office claims on saned.ai → "send payment link"
generates a real `checkout.thawani.om` link.

## Rollback
`git revert 2f44deb && git push origin HEAD:main`, or in Render redeploy the
previous successful deploy from the Deploys tab.

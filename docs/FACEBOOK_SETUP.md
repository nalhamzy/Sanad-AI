# Facebook / Meta WhatsApp Cloud API setup

This guide walks an operator from a fresh Meta developer account to a live WhatsApp number wired to the Sanad-AI Render deployment. Follow it in order — each step depends on the previous one.

The webhook handler lives at [routes/whatsapp.js](../routes/whatsapp.js); the agent it forwards to is [`runTurn`](../lib/agent.js) — the same backend the web `/chat.html` tester uses, so anything that works in the web tester will work in WhatsApp.

---

## 0 · Prerequisites

- A live Render deployment of Sanad-AI. The public URL is what Meta calls back; we'll refer to it as `https://<service>.onrender.com` throughout.
- A Facebook account that is a **Business Admin** of the business you'll attach to WhatsApp.
- A phone number you can receive SMS / voice on for verification. **It must not already be on a personal WhatsApp account** — Meta blocks reuse.
- Optional but strongly recommended: complete Meta Business verification (Settings → Business Info) before going to production. Test mode works without it.

---

## 1 · Create the Meta App

1. Go to https://developers.facebook.com/apps and sign in.
2. Click **My Apps → Create App**.
3. Use case: **Other** → click **Next**.
4. App type: **Business** → **Next**.
5. Display name: `sanad-ai` (any name works — citizens never see this).
6. Contact email: yours.
7. Business Account: pick or create one. If creating, give it the same legal name you'll register the WhatsApp number under.
8. Click **Create app**. Solve any captcha. You land on the App Dashboard.

---

## 2 · Add the WhatsApp product

1. From the left rail of the App Dashboard, click **Add Product**.
2. Find **WhatsApp** and click **Set up**.
3. Meta will create or attach a **WhatsApp Business Account (WABA)**. If asked, accept the default.
4. You're now on **WhatsApp → API Setup**. This is the page you'll come back to most often.

---

## 3 · Grab the credentials

On **WhatsApp → API Setup** you'll see four boxes:

| Meta UI field | `.env` key | Notes |
|---|---|---|
| **Temporary access token** | `WHATSAPP_ACCESS_TOKEN` | Expires in 24h. Fine for first smoke test; replace with a system-user token before launch (step 8). |
| **Phone number ID** | `WHATSAPP_PHONE_NUMBER_ID` | The numeric ID under the chosen test number. NOT the phone number itself. |
| **WhatsApp Business Account ID** | not used in code, useful for Graph API debugging | — |
| **App ID** | not used at runtime | — |

Copy the first two into your Render environment (Service → Environment → **+ Add Environment Variable**).

> Render Blueprint already prompts for these (see [render.yaml](../render.yaml)). If you used Blueprint, edit-in-place via Service → Environment.

---

## 4 · Get the App Secret (for webhook signature verification)

The app secret signs every inbound webhook so you know it actually came from Meta. The Sanad-AI webhook validates `X-Hub-Signature-256` against this secret ([routes/whatsapp.js:21–42](../routes/whatsapp.js)).

1. Top-left of the App Dashboard: **App settings → Basic**.
2. **App Secret** field → **Show** → enter your password → copy.
3. Add to Render env: `WHATSAPP_APP_SECRET = <the value>`.
4. Restart the service (Render does this automatically on env change).

> If `WHATSAPP_APP_SECRET` is empty, the Sanad-AI webhook **logs a warning and accepts every request unverified**. This is fine for local dev but a critical hole in production — check Render logs after deploy and confirm you don't see `signature verification DISABLED`.

---

## 5 · Pick a verify token

Meta uses this to confirm you own the webhook URL. It's a random string you make up — Meta sends it in the GET handshake; the route at [routes/whatsapp.js:44–49](../routes/whatsapp.js) echoes back the challenge only when the token matches.

1. Generate a random string: `openssl rand -hex 24` (or any password manager).
2. Add to Render env: `WHATSAPP_VERIFY_TOKEN = <that string>`.
3. Wait for the redeploy to finish.

---

## 6 · Configure the webhook in Meta

1. Back in the App Dashboard → **WhatsApp → Configuration**.
2. **Webhook** section → **Edit**.
3. **Callback URL**: `https://<service>.onrender.com/api/whatsapp/webhook`
   - Note the path: `/api/whatsapp/webhook` (the router is mounted at `/api/whatsapp` in [server.js](../server.js) and the handler is `/webhook`).
4. **Verify token**: paste the same string you set in `WHATSAPP_VERIFY_TOKEN`.
5. Click **Verify and save**.
   - Behind the scenes Meta GETs `https://<service>.onrender.com/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` and expects the challenge echoed back. If this fails, see Troubleshooting (§10).

---

## 7 · Subscribe to events

Same **Configuration** page, **Webhook fields** section.

| Field | Required for | Subscribe? |
|---|---|---|
| `messages` | Receiving inbound chat / media | **YES** — minimum |
| `message_status` | Delivery / read receipts back into your app | Later |
| `message_template_status_update` | Approval status of message templates | Later |
| Everything else | Not used by Sanad-AI today | No |

Click **Manage** → toggle `messages` ON → **Done**.

---

## 8 · Send the first test message

1. In **WhatsApp → API Setup**, scroll to **Send and receive messages**.
2. **To**: add your personal WhatsApp number as a tester (Meta sends a one-time code to verify). Test numbers are required during the first 24h of new apps — you can only message numbers you've explicitly added.
3. Send the canned `hello_world` template from the dashboard. You should receive it on your phone within seconds.
4. Reply to that WhatsApp message with `مرحبا` or `hello`.
5. On Render, watch logs (`Service → Logs`):
   - You should see the inbound message log line.
   - You should NOT see `signature verification failed` (that means `WHATSAPP_APP_SECRET` is wrong).
   - You should see `[whatsapp stub] would reply` if `WHATSAPP_ACCESS_TOKEN` is unset, or no log line and an actual reply on your phone if it is set.
6. The bot's reply should match what `/chat.html` would return for the same message.

---

## 9 · Going to production

The first 24h flow uses temporary credentials and a "from" number Meta provides. To talk to real citizens you need:

1. **Add your business phone number.** WhatsApp → Phone Numbers → **Add phone number** → verify by SMS or voice. Once verified, copy its new `phone_number_id` over `WHATSAPP_PHONE_NUMBER_ID`.
2. **Mint a permanent system-user token.** Business Settings → Users → System Users → Add → assign **WhatsApp Business Management** + **WhatsApp Business Messaging** to your app → **Generate New Token** → copy into `WHATSAPP_ACCESS_TOKEN`. This token doesn't expire.
3. **Submit message templates for approval.** WhatsApp can only initiate conversations using pre-approved templates (the citizen has to message you first inside a 24h "customer service window" otherwise). Templates are submitted at WhatsApp Manager → Message Templates. Approval is usually < 24h.
4. **Switch from test to live mode.** App Dashboard → top header → toggle from **Development** to **Live**. You'll be asked to set the **Privacy Policy URL** and complete Business Verification first.
5. **Move Render `DEBUG_MODE` to `false`.** [render.yaml](../render.yaml) ships with `DEBUG_MODE=true` for first-deploy smoke testing — flip it after you're satisfied.

---

## 10 · Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Meta "Webhook verification failed" on save | `WHATSAPP_VERIFY_TOKEN` mismatch, or Render redeploy still in progress | Confirm the token in Render env matches what you typed in Meta. Wait for the deploy to finish (Render shows a green check). Try again. |
| Inbound messages don't reach the bot | Wrong callback URL, or `messages` event not subscribed | URL must be `https://<service>.onrender.com/api/whatsapp/webhook` (note the `/api` prefix). Confirm `messages` is toggled on under Webhook fields. |
| Render logs show `signature verification failed` | `WHATSAPP_APP_SECRET` is wrong or missing | Re-copy from App settings → Basic → Show. Make sure there's no whitespace. Restart. |
| Render logs show `signature verification DISABLED` warning | `WHATSAPP_APP_SECRET` is empty | Set it in Render env. This is a critical security gap — fix before going live. |
| `Recipient phone number not in allowed list` (test mode) | Number you're messaging FROM hasn't been added as a test recipient in API Setup | Add the recipient on **API Setup → To** field. |
| `Message template not approved` | You're trying to start a conversation outside the 24h customer service window | Wait for the citizen to message first, OR submit and use an approved template. |
| 401 on outbound `POST /messages` | Token expired (the temporary one is 24h) or wrong scopes on system user | Regenerate a system-user token (step 9.2). |
| Replies arrive truncated / mangled | Reply > 4096 chars, or you used markdown that WhatsApp doesn't render | Run `npm run eval:whatsapp` — the WhatsApp-specific judge flags markdown leaks and over-long replies. |
| `429 Too Many Requests` on outbound | You've hit the WhatsApp tier limit (1K messages / 24h on tier 1) | Slow your worker, or apply for a higher tier in WhatsApp Manager. |

---

## Quick env-var checklist

Before flipping to live, confirm Render Service → Environment has all of these set:

- [ ] `ANTHROPIC_API_KEY` (real chat backend; without it, Claude is disabled)
- [ ] `QWEN_API_KEY` (still required for embeddings — semantic search collapses without it)
- [ ] `WHATSAPP_VERIFY_TOKEN` (matches the token you typed in Meta)
- [ ] `WHATSAPP_ACCESS_TOKEN` (system-user token, not the 24h temp one)
- [ ] `WHATSAPP_PHONE_NUMBER_ID` (from the verified business number, not the test number)
- [ ] `WHATSAPP_APP_SECRET` (from App settings → Basic)
- [ ] `SANAD_AGENT_V2=true` (default; set to `false` only to debug with the v1 heuristic)
- [ ] `DEBUG_MODE=false` (after first smoke test)

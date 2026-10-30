# 🤖 FB Sales Bot

An AI sales assistant for your Facebook Page. It answers customer messages and
post comments, negotiates within rules you set, takes orders, and notifies you.
You can jump into any conversation from the Facebook Page Inbox app on your phone.

**Stack:** Node.js + TypeScript · Claude API (Anthropic) · Meta Messenger Platform · SQLite.

---

## What it does

| Situation | Bot behaviour |
|---|---|
| Customer DMs the Page | Replies in the customer's language, answers from `knowledge.md` |
| Customer comments on a post | Posts a short public reply + sends one private message inviting them to chat |
| Customer negotiates | Applies only the discounts in `rules.json`; holds firm beyond that |
| Customer wants to buy | Collects name/phone/address, confirms total, saves the order, notifies you |
| Customer asks about an order | Looks it up by order number or phone |
| Customer is angry / asks for a human | Hands the conversation to you and pings your phone |
| You reply from the Page Inbox app | Bot pauses that thread automatically; resumes when you tap Done |

---

## Requirements

- macOS with Node.js 20+ (`node -v` to check)
- Your own Facebook Page, with you as admin
- A Claude API key (https://console.anthropic.com)
- The Mac stays on and online (the bot runs on it)

---

## Part A — Facebook / Meta setup (~15 min)

> ⚠️ **The #1 mistake:** leaving the app in *Development mode*. Meta then silently
> drops webhooks from real customers. Step A6 fixes this.

1. Open **https://developers.facebook.com** and log in with the Facebook account
   that administers your Page. Accept the developer terms if asked.

2. **Create an app:** *My Apps → Create App* → choose **Business** → name it
   (e.g. `Shop Sales Bot`) → Create.

3. In the app dashboard, find **Add products to your app** → **Messenger** →
   click **Set up**.

4. Under **Messenger → Settings → Access Tokens**, click **Add or Remove Pages**,
   pick your Page, allow access. Then click **Generate Token** next to your Page
   and **copy it** — this is `META_PAGE_TOKEN`.

5. Verify the token: open **https://developers.facebook.com/tools/debug/accesstoken/**,
   paste the token → **Debug**. It must show:
   - **Expires: Never**
   - Scopes include `pages_messaging` and `pages_manage_metadata`

6. **Switch the app to Live:** at the top of the dashboard use the
   **App Mode** toggle → **Live**. (If it asks for a privacy policy URL,
   any URL of your shop page works, e.g. your Facebook Page URL.)

7. Copy your **App ID** and **App Secret** from **App Settings → Basic**
   (click *Show* next to the secret).

8. Get your **Page ID**: on your Page, *About → Page transparency → Page ID*.

Now fill `META_PAGE_ID`, `META_PAGE_TOKEN`, `META_APP_ID`, `META_APP_SECRET`
into `.env` (Part D).

---

## Part B — A public HTTPS address (Tailscale Funnel, free)

Meta must be able to reach your Mac over HTTPS. Tailscale Funnel gives you a
stable, free `https://….ts.net` address that survives restarts.

1. Install Tailscale: **https://tailscale.com/download/mac** (or the Mac App Store),
   create a free account and sign in.

2. In the Tailscale admin console (**https://login.tailscale.com/admin/dns**):
   - enable **MagicDNS**
   - enable **HTTPS Certificates**

3. On the Mac, in *System Settings → Privacy & Security → Local Network*, allow
   Tailscale. Then in Terminal:

   ```bash
   tailscale funnel 3000
   ```

   Approve the prompt. It prints your public URL, e.g.
   `https://your-mac.tailnet-abc123.ts.net`.

4. Put that URL (no trailing slash) into `.env` as `WEBHOOK_PUBLIC_URL`.

> Funnel stays active across restarts once enabled (`tailscale funnel --bg 3000`
> runs it in the background). If the URL is unreachable after a reboot, run the
> command again.

<details>
<summary>Alternative: ngrok (URL changes on restart)</summary>

Install ngrok and run `ngrok http 3000`; copy the `https://…` URL into
`WEBHOOK_PUBLIC_URL` and re-run `npm run setup` after each restart.
</details>

---

## Part C — Claude API key

1. Go to **https://console.anthropic.com**, sign up / log in.
2. **Settings → API Keys → Create Key**, copy it into `.env` as `ANTHROPIC_API_KEY`.
3. Add a little credit under **Billing** (a few dollars lasts a long time — see *Cost*).

---

## Part D — Configure and run

```bash
cd ~/Documents/working/fb-sales-bot
cp .env.example .env        # then edit .env and fill in the values
npm install                 # once
npm run setup               # verifies tokens + registers the webhook
npm start                   # or ./start.sh (keeps the Mac awake)
```

`npm run setup` prints what it did. If step 2 (webhook) fails, the tunnel is not
running — see Part B.

<details>
<summary>Manual webhook registration (only if <code>npm run setup</code> can't do it)</summary>

In the App Dashboard → **Messenger → Settings → Webhooks**:

1. **Add Callback URL**: paste `https://<your-funnel-url>/webhook` and your
   `META_VERIFY_TOKEN` → **Verify and Save** (the bot must be running).
2. Click **Add Subscriptions** and tick: `messages`, `message_echoes`,
   `message_handovers`, `standby`, `feed`.
3. Then **Access Tokens → Add or Remove Pages** and re-subscribe your Page.
</details>

First run: the console asks you to register as the **owner**:

- In `.env`, set `OWNER_SETUP_CODE` to your own random code (don't use the
  example value — whoever sends it first becomes the owner).
- From your **personal** Facebook account, send that exact code to your Page.
- You'll get a confirmation and will now receive order/handover notifications.

---

## Part E — Teach the bot your products

- **`knowledge.md`** — products, prices, sizes, stock, shipping, payment, FAQ.
  The bot only uses what is written here. Edit and save; no restart needed.
- **`rules.json`** — negotiation guardrails: max discount %, free-shipping
  threshold, bulk discounts, things it must never promise, escalation triggers.

Start with your real prices and shipping policy, then chat with the bot yourself
and correct anything it gets wrong.

---

## Part F — Owner controls

Send these to the Page from your personal account (the registered owner):

| Message | Effect |
|---|---|
| `bot off` | Pause auto-replies for **all** customers |
| `bot on` | Resume |
| `bot tiếp` | Resume **all** paused conversations |
| `đơn 12 đã gửi` | Update order #12's status (customers see it via “đơn tới đâu rồi?”) |

**Taking over a conversation:** open the **Page Inbox** app → reply. The bot
notices your reply and pauses that thread for 60 minutes. If the bot escalates a
customer to you, it pings you (ntfy.sh + Messenger) and pauses until you reply.

---

## Testing checklist

Two offline tests need no Facebook account and no Claude credits (they use a
local mock API and a throwaway database):

- `npm run test:order` — order pipeline: validation, SQLite, `orders.csv`,
  status lookup by order number and by phone.
- `npm run test:claude` — the full Claude tool loop against a mock Anthropic
  server: request shape (model, thinking, effort, cached system prompt), a
  `save_order` tool call, and refusal handling. Cleans up after itself.

Then test the real plumbing. Run the server with `DRY_RUN=1 npm start` first so
no Claude credits are spent:

1. `npm run test:webhook` — simulates a verification handshake, two DMs, a post
   comment, an owner echo, owner enrolment, and the bot off/on commands. Watch
   the bot terminal; the Graph API errors are expected because the token is a
   dummy. **This test registers a fake owner** — before going live, stop the
   bot, `rm -rf data/`, and restart so your real account can send
   `OWNER_SETUP_CODE` and become the owner.
2. Set `DRY_RUN=0` and restart. From a **different** Facebook account (not the
   admin), DM the Page: expect a Vietnamese answer in ~3–5 s.
3. Comment “giá bao nhiêu?” on one of your posts: expect a public reply + one PM.
4. Complete an order end-to-end; check `data/orders.csv` and the owner notification.
5. Reply to a customer from the Page Inbox app on your phone; the bot must go
   quiet on that thread.

---

## Run 24/7 (auto-restart)

`./start.sh` keeps the Mac awake, but if the bot crashes nothing restarts it.
Install the included launchd service instead:

```bash
cp launchd/com.fb-sales-bot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.fb-sales-bot.plist
```

Logs: `data/bot.log`. To stop: `launchctl unload ~/Library/LaunchAgents/com.fb-sales-bot.plist`.

Also set **System Settings → Battery → Options → “Prevent automatic sleeping on
power adapter”** so the Mac stays reachable.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot answers nothing, no webhook logs | App is in **Development mode** → switch to Live (A6). Also check the tunnel is up. |
| `setup` webhook step fails | `tailscale funnel 3000` is not running, or `WEBHOOK_PUBLIC_URL` is wrong / has a trailing slash. |
| “Could not verify the Page access token” | Regenerate the Page token (A4) and confirm “Expires: Never”. |
| `(#10) … outside of allowed window` | More than 24 h since the customer's last message. Reply manually from Page Inbox; API replies are limited, manual ones are not. |
| Bot replies to itself / loops | Should not happen (echo + mid dedupe). If it does, stop the bot and check the logs for repeated mids. |
| Claude API 401 | Bad/missing `ANTHROPIC_API_KEY`. |
| Mac slept, messages missed | Use `./start.sh` or the launchd service, and the battery setting above. |
| Private reply to comment fails | One private reply per comment is allowed within 7 days; the bot already caps to 1 PM / 7 days per person. Falls back to public comment replies. |
| launchd logs `Operation not permitted` for the project folder | macOS privacy protection blocks background jobs from reading `~/Documents`. Grant **Full Disk Access** to `/bin/zsh` (System Settings → Privacy & Security → Full Disk Access → + → press ⇧⌘G and enter `/bin/zsh`), then reload the launchd service. |

---

## Cost

Claude is the only paid component.

- Model: `claude-opus-5-5` — $4 / $20 per million input/output tokens; cached
  knowledge reads at $0.20 / million.
- Typical turn: ~$0.01–0.016 → **~$15–50/month at ~100 customer messages/day**.
- Lower it: keep `BOT_EFFORT=low`, keep `knowledge.md` concise, run a cheaper
  model by changing `BOT_MODEL` (e.g. `claude-sonnet-5-5`).
- Everything else is free: Meta API for your own Page, Tailscale Funnel, ntfy.sh.

---

## How it is built

```
Facebook → Tailscale Funnel → src/index.ts (Express)
   webhooks.ts  verify HMAC, dedupe, route messages / feed comments / handovers
   claude.ts    Claude API call + tool loop (save_order, get_order_status, handover_to_owner)
   prompt.ts    cached system prompt built from knowledge.md + rules.json
   meta.ts      Graph API: send, comment reply, private reply, thread control
   store.ts     SQLite: history, orders, pauses, dedupe, settings
   orders.ts    order validation, CSV export, owner notification
   handover.ts  owner takeover + echo detection
```

Customer conversations, orders and state live in `data/bot.db` (SQLite);
orders are also exported to `data/orders.csv`.

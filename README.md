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
| Customer asks for a product photo | Sends matching images from `assets/images/` (up to 4 per call) |
| Customer asks something not in `knowledge.md` | Pings you with `notify_owner` but keeps replying; does not pause the thread |
| Customer is angry / asks for a human | Hands the conversation to you and pings your phone |
| You reply from the Page Inbox app | Bot pauses that thread automatically; send `bot tiếp` to reclaim it |

---

## Requirements

- macOS with Node.js 20+ (`node -v` to check)
- Your own Facebook Page, with you as admin
- A Claude API key (default) or a DeepSeek API key — see Part C
- The Mac stays on and online (the bot runs on it)

---

## Part A — Facebook / Meta setup (step by step)

> ⚠️ **Two mistakes cause almost every failure:**
> 1. The app is left in **Development mode** — Meta silently drops real
>    customers' webhooks.
> 2. The Page has **no default app in Conversation Routing** — Page Inbox owns
>    the conversations and the bot only receives `standby` events, so it cannot
>    reply.
>
> Both are covered below (A7 and A8).

Use a **desktop browser**. Some of these screens do not exist in the mobile app.
Meta renames menus from time to time; the direct URLs are the reliable path.

### A0. Accounts and roles

- A Facebook account that is **admin** of the Page.
- A Meta developer account: open https://developers.facebook.com and accept the
  developer terms.
- The Facebook Page already created.

### A1. Create the Meta app

1. Open https://developers.facebook.com/apps/ → **Create app**.
2. Use case: **Business** → **Next**.
3. Enter an app name (e.g. `Shop Sales Bot`) and contact email → **Create app**.
4. The dashboard shows the **App ID** at the top. You need it in `.env`.
5. **App Secret:** App Dashboard → **App settings → Basic** → **App secret** →
   **Show**. Copy it — you need it in `.env`.

### A2. Add the Messenger product and connect the Page

1. App Dashboard → **Add products to your app** → **Messenger** → **Set up**.
2. **Messenger → Settings → Access Tokens** → **Add or Remove Pages**.
3. Select your Page → **Allow**.
4. Next to the Page, click **Generate Token** and copy it. This is a
   **Page access token** — `META_PAGE_TOKEN`.

> The token must be a **PAGE** token, not a **USER** token. A user token can read
> the Page but cannot subscribe it or send messages as the Page. If you use one,
> `subscribed_apps` fails with `Invalid OAuth 2.0 Access Token`.

### A3. Get the Page ID

Three ways; all must give the **same** number:

- Page → **About** → **Page transparency** → **Page ID**.
- Graph API: `GET /me/accounts?fields=id,name` with a user token.
- The token's `profile_id` from `debug_token` (see A5).

> **The Page ID must equal the token's `profile_id`.** If they differ, Graph API
> returns `(#100) Unsupported get request… Object with ID … does not exist`
> (`error_subcode: 33`). This is the most common “page ID” error.

### A4. Get a never-expiring Page token (two methods)

**Method 1 — Messenger dashboard (easiest)**

**Messenger → Settings → Access Tokens → Add or Remove Pages → Generate Token.**
Paste it into https://developers.facebook.com/tools/debug/accesstoken/ and check
**Expires: Never**.

**Method 2 — Graph API Explorer (full control over scopes)**

Use this when the dashboard token is missing a scope, or when you need a
never-expiring token with exactly the right permissions.

1. Open https://developers.facebook.com/tools/explorer/
2. Select your app.
3. Add permissions: `pages_show_list`, `pages_read_engagement`,
   `pages_manage_metadata`, `pages_messaging`.
4. **Generate Access Token** → log in → approve.
5. Exchange the short-lived user token for a long-lived one:
   ```
   GET https://graph.facebook.com/v23.0/oauth/access_token
       ?grant_type=fb_exchange_token
       &client_id=<META_APP_ID>
       &client_secret=<META_APP_SECRET>
       &fb_exchange_token=<SHORT_USER_TOKEN>
   ```
6. Call `GET /me/accounts?fields=id,name,access_token` with the long-lived token.
   Copy the `access_token` of your Page. Its `expires_at` should be `0`.
7. Put that Page token in `META_PAGE_TOKEN`.

> `pages_read_engagement` is optional for the bot (it is only used to display the
> Page name). `pages_messaging` and `pages_manage_metadata` are required.

### A5. Verify the token

Open https://developers.facebook.com/tools/debug/accesstoken/, paste the token →
**Debug**. It must show:

| Field | Expected |
|---|---|
| Type | **PAGE** |
| Profile ID | exactly your `META_PAGE_ID` |
| Expires | **Never** (`expires_at: 0`) |
| Scopes | `pages_messaging`, `pages_manage_metadata` (plus optional `pages_read_engagement`) |

Or from the terminal:

```bash
curl -sG "https://graph.facebook.com/v23.0/debug_token" \
  --data-urlencode "input_token=$META_PAGE_TOKEN" \
  --data-urlencode "access_token=$META_APP_ID|$META_APP_SECRET"
```

### A6. Fill `.env`

Copy `.env.example` to `.env` and fill:

| Variable | Where to get it |
|---|---|
| `META_PAGE_ID` | A3 |
| `META_PAGE_TOKEN` | A4 — PAGE token, never expires |
| `META_APP_ID` | A1 |
| `META_APP_SECRET` | A1 |
| `META_VERIFY_TOKEN` | Invent a random string (≥ 6 chars). Paste the same value into the webhook screen. |
| `WEBHOOK_PUBLIC_URL` | Part B |

### A7. Go Live

1. Open `https://developers.facebook.com/apps/<META_APP_ID>/go_live/`
   (or App Dashboard → top bar → **App Mode → Live**).
2. Before it lets you switch, fill **App settings → Basic**:
   - **App icon**: 1024×1024 PNG.
   - **Privacy Policy URL**: a public HTTPS page that loads without login. If
     Meta rejects your Page URL, publish a Google Doc
     (*Share → Anyone with the link*) with a short policy.
   - **Terms of Service URL**: same idea.
   - **User Data Deletion**: *Data Deletion Instructions URL* — the same page is
     fine.
   - **Category**: *Business and Pages* or *Shopping & Retail*.
   - **Contact email**.
   - **Save changes**.
3. Return to the go-live page → **Live** → confirm.
4. If the switch is blocked, the dialog lists the missing fields. Fill them and
   try again.

> **Live mode is not App Review.** Live makes the app public, but permissions
> such as `pages_messaging` may still be limited to admins/developers/testers
> unless you have **Advanced Access** (A9).

### A8. Conversation Routing — set your bot as the default app (critical)

If you skip this, **Page Inbox keeps ownership of conversations**. The bot then
receives `standby` webhooks and must stay silent; `take_thread_control` fails
with `(#27) … Conversation Routing not enabled`.

1. On facebook.com, click your avatar → **See all profiles** → select your Page.
2. Open **Page settings → Page setup → Messenger conversation routing**.
   Direct link: https://www.facebook.com/settings?tab=msgr_conversation_routing
   (you must be acting as the Page).
3. Set **Default app / Default routing app** = your bot app (e.g. `Chat bot`).
   - No default yet: **Set up → Get started** → select the app → **Continue**.
   - Wrong app: **⋯ → Edit** → select the app → **Save**.
4. In **Page setup → Advanced messaging → Connected apps**, edit your app and
   enable **Access standby channel** and **Take control of conversations** →
   **Save**.
5. Alternative path: **Meta Business Suite → Settings → Integrations →
   Conversation routing** → select the Page → **Routing** → **Set up/Edit**.
6. Verify:
   ```bash
   curl -sG "https://graph.facebook.com/v23.0/me" \
     --data-urlencode "fields=messaging_feature_status" \
     --data-urlencode "access_token=$META_PAGE_TOKEN"
   ```
   - `hop_v2: true` — routing is enabled.
   - `msgr_multi_app: true` — a default app is set.
   - `msgr_multi_app: false` — **no default app**; the bot will only see standby.
7. Conversations already owned by Page Inbox: open them in Page Inbox / Meta
   Business Suite and mark them **Done**. Or send `bot tiếp` from the owner
   account — the bot tries to reclaim control and reports how many it got.

> If the menu is missing: use a desktop browser, make sure you are in the Page
> profile, search settings for “routing”, and try Meta Business Suite. Meta moves
> and renames these menus regularly.

### A9. Testers and App Review

- **Test now (no review):** App Dashboard → **App roles → Roles** → **Add people
  → Tester**. Accept the invitation from the test account. Testers can message
  the Page even without Advanced Access.
- **Real customers:** App Dashboard → **App Review → Permissions and Features**
  → request **Advanced Access** for `pages_messaging` (and
  `pages_manage_metadata`, `pages_show_list` if asked). You will need a privacy
  policy, a short screencast, test credentials and step-by-step instructions.
  Business verification may be required.

### A10. Register the webhook (manual alternative)

`npm run setup` does this for you. To do it by hand:

1. App Dashboard → **Messenger → Settings → Webhooks** → **Add Callback URL**.
2. Callback URL: `https://<your-public-url>/webhook`
3. Verify Token: the exact `META_VERIFY_TOKEN` from `.env`.
4. **Verify and Save** — the bot and the Funnel must be running.
5. **Add subscriptions**: `messages`, `message_deliveries`, `message_echoes`,
   `messaging_handovers`, `standby`, `feed`.
6. **Access Tokens → Add or Remove Pages** → re-subscribe the Page.

---

## Part B — A public HTTPS address (Tailscale Funnel, free)

Meta must be able to reach your Mac over HTTPS. Tailscale Funnel gives you a
stable, free `https://….ts.net` address that survives restarts.

1. Install Tailscale: **https://tailscale.com/download/mac** (or the Mac App
   Store), create a free account and sign in.
2. Enable HTTPS and MagicDNS in the Tailscale admin console
   (**https://login.tailscale.com/admin/dns**):
   - **MagicDNS** on
   - **HTTPS Certificates** on
3. On the Mac, allow Tailscale in *System Settings → Privacy & Security → Local
   Network*. Then start Funnel in the background:
   ```bash
   tailscale funnel --bg 3000
   ```
   The first run may open a browser to approve Funnel. It prints the public URL,
   e.g. `https://your-mac.tailnet-abc123.ts.net`.
4. Verify:
   ```bash
   tailscale funnel status
   curl -sS https://<your-url>/health
   ```
   `funnel status` must show `Funnel on` and proxy `http://127.0.0.1:3000`.
   `/health` returns JSON while the bot (or `npm run setup`'s temporary server)
   is running.
5. Put the URL (no trailing slash) into `.env` as `WEBHOOK_PUBLIC_URL`.

> **`SSL_ERROR_SYSCALL` / `Connection established` during setup** means Meta
> reached the URL but the TLS handshake failed: Funnel is not running, or HTTPS
> Certificates are not enabled. Fix this before re-running setup.

> Funnel stays active across restarts once enabled with `--bg`. If the URL is
> unreachable after a reboot, run the command again.

<details>
<summary>Alternative: ngrok (URL changes on restart)</summary>

Install ngrok and run `ngrok http 3000`; copy the `https://…` URL into
`WEBHOOK_PUBLIC_URL` and re-run `npm run setup` after each restart.
</details>

---

## Part C — AI brain key (Claude or DeepSeek)

The bot supports two providers. **Claude is the default and gives the best
Vietnamese sales quality.** DeepSeek is much cheaper and speaks the same
Anthropic-compatible API.

### Claude (default)

1. Go to **https://console.anthropic.com**, sign up / log in.
2. **Settings → API Keys → Create Key**, copy it into `.env` as `ANTHROPIC_API_KEY`.
3. Add a little credit under **Billing** (a few dollars lasts a long time — see *Cost*).

### DeepSeek (optional, cheaper)

1. Go to **https://platform.deepseek.com**, create an API key.
2. In `.env`, set:
   ```bash
   BOT_PROVIDER=deepseek
   DEEPSEEK_API_KEY=sk-...
   # Optional: BOT_MODEL=deepseek-v4-flash   (cheaper) or deepseek-v4-pro (default)
   ```
   Leave `ANTHROPIC_API_KEY` empty — it is not used in this mode.
3. Start the bot as usual. To switch back, set `BOT_PROVIDER=anthropic` and fill
   in `ANTHROPIC_API_KEY`.

> **Privacy:** with DeepSeek, every customer message and order detail (name,
> address, phone) is processed by DeepSeek's API instead of Anthropic. Make sure
> that is acceptable for your business and your customers before using it in
> production.

> **Note:** this is the bot's runtime provider. It is separate from whichever
> model Claude Code uses while you edit the project.

---

## Part D — Configure and run

```bash
cd ~/Documents/working/fb-sales-bot
cp .env.example .env        # then edit .env using the table in A6
npm install                 # once
npm run setup               # verifies the token, registers the webhook, subscribes the Page
npm start                   # or ./start.sh (keeps the Mac awake)
```

Expected `npm run setup` output:

```
— 1/4 Verify Page token
✅ Connected to Page "…" (id …)

— 2/4 Register webhook with Meta
✅ Webhook registered: https://…/webhook

— 3/4 Subscribe the Page to webhook fields
✅ Page subscribed (messages, message_echoes, message_handovers, standby, feed)
```

If step 2 fails, the Funnel is not reachable (Part B). If step 3 fails, the
token is missing `pages_manage_metadata` (A4/A5), or it is a USER token instead
of a PAGE token.

<details>
<summary>Manual webhook registration (only if <code>npm run setup</code> can't do it)</summary>

In the App Dashboard → **Messenger → Settings → Webhooks**:

1. **Add Callback URL**: paste `https://<your-funnel-url>/webhook` and your
   `META_VERIFY_TOKEN` → **Verify and Save** (the bot must be running).
2. Click **Add Subscriptions** and tick: `messages`, `message_deliveries`,
   `message_echoes`, `messaging_handovers`, `standby`, `feed`.
3. Then **Access Tokens → Add or Remove Pages** and re-subscribe your Page.
</details>

First run: the console asks you to register as the **owner**:

- In `.env`, set `OWNER_SETUP_CODE` to your own random code (don't use the
  example value — whoever sends it first becomes the owner).
- From your **personal** Facebook account, send that exact code to your Page.
- You'll get a confirmation and will now receive order/handover notifications.
- The owner account is a **control account**: the bot deliberately does not
  auto-reply to its normal messages. Test customer conversations from a
  different account (A9).

---

## Part E — Teach the bot your products

- **`knowledge.md`** — products, prices, sizes, stock, shipping, payment, FAQ.
  The bot only uses what is written here. Edit and save; no restart needed.
- **`rules.json`** — negotiation guardrails: max discount %, free-shipping
  threshold, bulk discounts, things it must never promise, escalation triggers.
- **`assets/images/`** — product photos. Name each file after its SKU, e.g.
  `wf-02-nau.jpg`, `wf-02-den.jpg`. The bot sends them automatically when a
  customer asks for photos (up to 4 per tool call). They are served publicly
  through the Funnel at `/images/...`, so keep only product images there.

Start with your real prices and shipping policy, then chat with the bot yourself
and correct anything it gets wrong.

---

## Part F — Owner controls

Send these to the Page from your personal account (the registered owner):

| Message | Effect |
|---|---|
| `bot off` | Pause auto-replies for **all** customers |
| `bot on` | Resume |
| `bot tiếp` | Resume paused conversations and try to reclaim them from Page Inbox |
| `đơn 12 đã gửi` | Update order #12's status (customers see it via “đơn tới đâu rồi?”) |

**Taking over a conversation:** open the **Page Inbox** app → reply. The bot
notices your reply and pauses that thread for 60 minutes. If the bot escalates a
customer to you, it pings you (ntfy.sh + Messenger) and pauses until you reply.
When you are ready to hand back, send `bot tiếp`; the bot calls
`take_thread_control` and reports how many threads it reclaimed.

**Missing information:** the bot uses `notify_owner` instead of a full handover
when a customer asks something that is not in `knowledge.md` (for example the
product origin). You get a notification, but the bot keeps replying and the
thread is not paused.

---

## Testing checklist

Two offline tests need no Facebook account and no Claude credits (they use a
local mock API and a throwaway database):

- `npm run test:order` — order pipeline: validation, SQLite, `orders.csv`,
  status lookup by order number and by phone.
- `npm run test:claude` — the full Claude tool loop against a mock Anthropic
  server: request shape (model, thinking, effort, cached system prompt), a
  `save_order` tool call, and refusal handling. Cleans up after itself.
- `npm run test:deepseek` — the same loop with `BOT_PROVIDER=deepseek`, checking
  the DeepSeek model default and Bearer authentication. Also offline.

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
6. Ask for a product photo (“cho xem ảnh WF-02”): expect image attachments. The
   files in `assets/images/` are placeholders — replace them before real sales.
7. After a takeover, send `bot tiếp` from the owner account; the bot should
   report how many threads it reclaimed from Page Inbox.

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
| Bot answers nothing, no webhook logs | Check **App Mode = Live** (A7), the Funnel is up (B), and **Conversation Routing** has your app as default (A8). In Development mode only admins/testers get webhooks. |
| Log shows `standby event … Page Inbox owns thread` | Page Inbox owns the conversation. Set your app as the default in Conversation Routing (A8), mark the chat **Done**, or send `bot tiếp` from the owner. |
| `take_thread_control` fails with `(#27) … Conversation Routing not enabled` | No default app is set. Complete A8; verify `msgr_multi_app: true`. |
| `(#100) Unsupported get request… Object with ID … does not exist` | `META_PAGE_ID` does not match the token's `profile_id`. Compare both with the debug tool (A3/A5). |
| `Invalid OAuth 2.0 Access Token` on `subscribed_apps` | You used a **USER** token instead of a **PAGE** token, or the token expired. Get a PAGE token (A4); debug must show Type = PAGE. |
| `(#200) Requires pages_manage_metadata` | The token is missing that scope. Regenerate it with the permissions in A4. |
| `(#100) … requires pages_read_engagement` | Optional scope missing. The code falls back to `messenger_profile`; add the scope if you want the Page name in logs. |
| `setup` webhook step fails | `tailscale funnel --bg 3000` is not running, HTTPS Certificates are off, or `WEBHOOK_PUBLIC_URL` is wrong / has a trailing slash. |
| “Could not verify the Page access token” | Regenerate the Page token (A4) and confirm Type = PAGE, Expires = Never, and `profile_id` = `META_PAGE_ID`. |
| Images are not delivered | `WEBHOOK_PUBLIC_URL` must be public HTTPS; open `https://<url>/images/wf-02-nau.png` in a browser. File names must start with the SKU (`wf-02-nau.jpg`). |
| Owner messages get no reply | By design — the owner account is a control account. Test from a customer account, or send `bot off` / `bot on` / `bot tiếp` / `đơn 12 đã gửi`. |
| App is Live but only testers get replies | `pages_messaging` lacks Advanced Access. Add the account as a Tester (A9) or pass App Review. |
| `(#10) … outside of allowed window` | More than 24 h since the customer's last message. Reply manually from Page Inbox; API replies are limited, manual ones are not. |
| Bot replies to itself / loops | Should not happen (echo + mid dedupe). If it does, stop the bot and check the logs for repeated mids. |
| AI API 401 | Bad/missing `ANTHROPIC_API_KEY` (or `DEEPSEEK_API_KEY` when `BOT_PROVIDER=deepseek`). |
| Mac slept, messages missed | Use `./start.sh` or the launchd service, and the battery setting above. |
| Private reply to comment fails | One private reply per comment is allowed within 7 days; the bot already caps to 1 PM / 7 days per person. Falls back to public comment replies. |
| launchd logs `Operation not permitted` for the project folder | macOS privacy protection blocks background jobs from reading `~/Documents`. Grant **Full Disk Access** to `/bin/zsh` (System Settings → Privacy & Security → Full Disk Access → + → press ⇧⌘G and enter `/bin/zsh`), then reload the launchd service. |

---

## Cost

The AI API is the only paid component.

- Claude `claude-opus-5-5` — $4 / $20 per million input/output tokens; cached
  knowledge reads at $0.20 / million.
- Typical Claude turn: ~$0.01–0.016 → **~$15–50/month at ~100 customer messages/day**.
- Lower it: keep `BOT_EFFORT=low`, keep `knowledge.md` concise, run a cheaper
  model by changing `BOT_MODEL` (e.g. `claude-sonnet-5-5`).
- DeepSeek (`BOT_PROVIDER=deepseek`) is substantially cheaper per message — see
  DeepSeek's current pricing. Start with `deepseek-v4-pro` and compare quality
  against Claude on a few real conversations before committing.
- Everything else is free: Meta API for your own Page, Tailscale Funnel, ntfy.sh.

---

## How it is built

```
Facebook → Tailscale Funnel → src/index.ts (Express)
   webhooks.ts  verify HMAC, dedupe, route messages / comments / handovers / standby
   claude.ts    AI call + tool loop (orders, images, notify owner, handover)
   prompt.ts    cached system prompt built from knowledge.md + rules.json
   meta.ts      Graph API: text/image send, comment reply, private reply, thread control
   store.ts     SQLite: history, orders, pauses, dedupe, settings
   orders.ts    order validation, CSV export, product-image tool, notifications
   handover.ts  owner takeover + echo detection
```

Customer conversations, orders and state live in `data/bot.db` (SQLite);
orders are also exported to `data/orders.csv`.

/**
 * One-shot setup wizard:
 *   1. verifies your Page token
 *   2. registers the app webhook with Meta (needs the server reachable via the tunnel)
 *   3. subscribes the Page to the webhook fields
 *   4. prints what to do next
 *
 * Run: npm run setup
 */
import http from "node:http";
import { config } from "../src/config";
import { getPageInfo, subscribePage, updateAppWebhook } from "../src/meta";

const ok = (msg: string) => console.log(`✅ ${msg}`);
const warn = (msg: string) => console.log(`⚠️  ${msg}`);
const step = (msg: string) => console.log(`\n— ${msg}`);

async function isBotRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Temporary server so Meta can verify the webhook while the bot itself is not running. */
function startTempVerifyServer(): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${config.PORT}`);
      if (req.method === "GET" && url.pathname === "/webhook") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        if (mode === "subscribe" && token === config.META_VERIFY_TOKEN) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(url.searchParams.get("hub.challenge") ?? "");
          return;
        }
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    srv.once("error", reject);
    srv.listen(config.PORT, () => resolve(srv));
  });
}

async function main(): Promise<void> {
  console.log("\n🛠  FB Sales Bot — setup\n");

  step("1/4 Verify Page token");
  const page = await getPageInfo();
  ok(`Connected to Page "${page.name}" (id ${page.id})`);

  step("2/4 Register webhook with Meta");
  if (!config.WEBHOOK_PUBLIC_URL) {
    warn(
      "WEBHOOK_PUBLIC_URL is not set. Skipping automatic webhook registration.\n" +
        "   → Follow README Part B (Tailscale Funnel), put the https URL into .env, then run npm run setup again."
    );
  } else {
    const running = await isBotRunning();
    let temp: http.Server | undefined;
    if (!running) {
      console.log("   Bot is not running — starting a temporary verification server…");
      temp = await startTempVerifyServer();
    }
    try {
      await updateAppWebhook(`${config.WEBHOOK_PUBLIC_URL.replace(/\/$/, "")}/webhook`);
      ok(`Webhook registered: ${config.WEBHOOK_PUBLIC_URL}/webhook`);
    } catch (err) {
      warn(
        `Webhook registration failed: ${err instanceof Error ? err.message : err}\n` +
          "   → Check that Tailscale Funnel is running and the public URL is correct."
      );
    } finally {
      temp?.close();
    }
  }

  step("3/4 Subscribe the Page to webhook fields");
  await subscribePage();
  ok("Page subscribed (messages, message_echoes, message_handovers, standby, feed)");

  step("4/4 Done");
  console.log(`
Next steps:
  1. Start the bot:            npm start   (or ./start.sh to keep the Mac awake)
  2. From your personal FB account, send this exact message to your Page:
        ${config.OWNER_SETUP_CODE}
     (this registers you as the owner for notifications & control commands)
  3. Fill in knowledge.md and rules.json with your real products and prices.
  4. Test from another account: DM the Page, and comment on a post.

Reminders:
  • The Meta app must be in LIVE mode, or customer webhooks are silently dropped.
  • Keep the tunnel running: tailscale funnel ${config.PORT}
`);
}

main().catch((err) => {
  console.error("\n❌ Setup failed:", err instanceof Error ? err.message : err);
  console.error("   See README.md → Troubleshooting.\n");
  process.exit(1);
});

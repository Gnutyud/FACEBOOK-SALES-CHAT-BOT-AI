import express from "express";
import { config } from "./config";
import { webhookRouter } from "./webhooks";
import { getPageInfo, subscribePage } from "./meta";
import { getOwnerPsid, isBotEnabled, pruneDedupe } from "./store";

const app = express();

app.use(webhookRouter);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    bot_enabled: isBotEnabled(),
    dry_run: config.DRY_RUN,
    model: config.BOT_MODEL,
    owner_registered: Boolean(getOwnerPsid()),
  });
});

app.use((_req, res) => res.sendStatus(404));

const server = app.listen(config.PORT, () => {
  console.log(`\n🤖 FB Sales Bot listening on http://localhost:${config.PORT}`);
  console.log(`   model: ${config.BOT_MODEL} (effort=${config.BOT_EFFORT})`);
  if (config.DRY_RUN) console.log("   ⚠️  DRY_RUN is ON — Claude will not be called");
  if (config.WEBHOOK_PUBLIC_URL)
    console.log(`   public webhook: ${config.WEBHOOK_PUBLIC_URL}/webhook`);
  else console.log("   ⚠️  WEBHOOK_PUBLIC_URL is not set — see README Part B (Tailscale)");
});

async function boot(): Promise<void> {
  try {
    const page = await getPageInfo();
    console.log(`   page: ${page.name} (${page.id})`);
  } catch (err) {
    console.error(
      "   ⚠️  Could not verify the Page access token. Check META_PAGE_ID / META_PAGE_TOKEN in .env.\n",
      err instanceof Error ? err.message : err
    );
  }

  try {
    await subscribePage();
    console.log("   subscribed page webhooks: messages, echoes, handovers, standby, feed");
  } catch (err) {
    console.error(
      "   ⚠️  Could not subscribe the Page to webhooks. Check the token scopes (pages_messaging, pages_manage_metadata).\n",
      err instanceof Error ? err.message : err
    );
  }

  pruneDedupe();
  setInterval(pruneDedupe, 6 * 60 * 60 * 1000).unref?.();

  const owner = getOwnerPsid();
  if (!owner) {
    console.log(
      `\n👉 Owner not registered yet. From your personal Facebook account, send this exact message to your Page:\n   ${config.OWNER_SETUP_CODE}\n   That account will receive order notifications and can control the bot (bot off / bot on / "đơn 12 đã gửi").\n`
    );
  } else {
    console.log(`   owner PSID: ${owner}`);
  }
}

boot().catch((err) => console.error("[boot] error:", err));

function shutdown(): void {
  console.log("\n[bot] shutting down…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (err) => console.error("[bot] unhandled rejection:", err));

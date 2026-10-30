/**
 * Local webhook simulator — test the bot without Facebook.
 *
 *   1. In one terminal:  npm start
 *   2. In another:       npm run test:webhook
 *
 * Tip: run the server with DRY_RUN=1 to test the plumbing without spending Claude credits.
 */
import crypto from "node:crypto";
import { config } from "../src/config";

const BASE = `http://127.0.0.1:${config.PORT}`;
const TEST_USER = "test-user-123";
const TEST_COMMENT_ID = `test-comment-${Date.now()}`;

function sign(payload: unknown): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  const signature =
    "sha256=" +
    crypto.createHmac("sha256", config.META_APP_SECRET).update(body).digest("hex");
  return { body, signature };
}

async function postPayload(label: string, payload: unknown): Promise<void> {
  const { body, signature } = sign(payload);
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body,
  });
  console.log(`${res.ok ? "✅" : "❌"} ${label} → HTTP ${res.status}`);
}

function dmPayload(mid: string, text: string, sender = TEST_USER, isEcho = false) {
  return {
    object: "page",
    entry: [
      {
        id: config.META_PAGE_ID,
        time: Date.now(),
        messaging: [
          {
            sender: { id: isEcho ? config.META_PAGE_ID : sender },
            recipient: { id: isEcho ? sender : config.META_PAGE_ID },
            timestamp: Date.now(),
            message: isEcho ? { mid, text, is_echo: true } : { mid, text },
          },
        ],
      },
    ],
  };
}

async function main(): Promise<void> {
  console.log("\n🧪 FB Sales Bot — local webhook test\n");

  let dryRun = false;
  try {
    const health = await fetch(`${BASE}/health`);
    const info = (await health.json()) as { dry_run?: boolean; bot_enabled?: boolean };
    dryRun = Boolean(info.dry_run);
    console.log(`Server is up. dry_run=${info.dry_run}, bot_enabled=${info.bot_enabled}`);
  } catch {
    console.error(`❌ No server on ${BASE}. Start it first: npm start`);
    process.exit(1);
  }
  if (dryRun) {
    console.log("ℹ️  This server is in DRY_RUN mode (recommended for setup tests).\n");
  } else {
    console.log(
      "⚠️  This server is NOT in DRY_RUN mode. Owner-enrolment and bot on/off\n" +
        "    payloads will be skipped so a fake test account can never become owner.\n"
    );
  }

  // 1. Webhook verification handshake
  const challenge = `challenge-${Date.now()}`;
  const verifyUrl = `${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
    config.META_VERIFY_TOKEN
  )}&hub.challenge=${challenge}`;
  const verifyRes = await fetch(verifyUrl);
  const verifyBody = await verifyRes.text();
  console.log(
    `${verifyRes.ok && verifyBody === challenge ? "✅" : "❌"} verification handshake → "${verifyBody}"`
  );

  // 2. Incoming customer DM
  await postPayload(
    "customer DM",
    dmPayload(`mid-${Date.now()}-1`, "Shop ơi sản phẩm này giá bao nhiêu vậy?")
  );

  // 3. Second DM (memory check)
  await new Promise((r) => setTimeout(r, 1500));
  await postPayload(
    "customer DM (follow-up)",
    dmPayload(`mid-${Date.now()}-2`, "Có giao hàng COD không shop?")
  );

  // 4. Post comment (→ public reply + one private reply)
  await postPayload("post comment", {
    object: "page",
    entry: [
      {
        id: config.META_PAGE_ID,
        time: Date.now(),
        changes: [
          {
            field: "feed",
            value: {
              item: "comment",
              verb: "add",
              comment_id: TEST_COMMENT_ID,
              post_id: "test-post-1",
              from: { id: TEST_USER, name: "Khách Test" },
              message: "Giá bao nhiêu vậy shop?",
            },
          },
        ],
      },
    ],
  });

  // 5. Echo from the owner (simulates a reply typed in the Page Inbox app)
  await postPayload(
    "owner echo (should pause the thread)",
    dmPayload(`mid-${Date.now()}-echo`, "Chị để shop tư vấn thêm nhé", TEST_USER, true)
  );

  if (dryRun) {
    // 6. Owner enrolment (only works while no owner is registered)
    await postPayload(
      "owner setup code",
      dmPayload(`mid-${Date.now()}-setup`, config.OWNER_SETUP_CODE)
    );

    // 7. Owner control commands
    await postPayload("owner command: bot off", dmPayload(`mid-${Date.now()}-off`, "bot off"));
    await postPayload("owner command: bot on", dmPayload(`mid-${Date.now()}-on`, "bot on"));
  } else {
    console.log("⏭️  skipped owner setup code and bot off/on (server is live)");
  }

  console.log(`
Done. Check the bot terminal for replies and [claude] usage lines.
Notes:
  • With DRY_RUN=1 the bot replies with a canned test message instead of calling Claude.
  • A real reply requires valid META_PAGE_TOKEN and an open 24h window with the real user.
${
  dryRun
    ? `  • This test registered the fake user "${TEST_USER}" as the shop owner in the bot's
    database. Before going live, stop the bot, delete data/ and restart, so your real
    account can register with OWNER_SETUP_CODE.`
    : "  • Owner enrolment and bot on/off were skipped because the server is live."
}
`);
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});

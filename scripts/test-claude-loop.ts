/**
 * Offline test of the full Claude tool loop against a MOCK Anthropic endpoint.
 * Verifies request shape, tool execution, history persistence and refusal handling
 * without spending real API credits.
 *
 * Run: npm run test:claude
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Throwaway data dir so the test never touches real conversations or orders.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fb-bot-claude-test-"));

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.META_PAGE_ID = "123456789";
process.env.META_PAGE_TOKEN = "dummy-token";
process.env.META_APP_ID = "111";
process.env.META_APP_SECRET = "testsecret";
process.env.META_VERIFY_TOKEN = "verify123";
process.env.OWNER_SETUP_CODE = "TEST-CODE-9876";
process.env.BOT_DATA_DIR = TEST_DATA_DIR;
process.env.DRY_RUN = "0";

const requests: any[] = [];
let mode: "tool" | "text" | "refusal" = "tool";

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    requests.push(parsed);

    let content: unknown[];
    let stopReason: string;
    if (mode === "tool" && requests.length === 1) {
      content = [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "save_order",
          input: {
            customer_name: "Khách Test",
            phone: "0901234567",
            address: "123 Đường Test, Quận 1, TP.HCM",
            items: [{ product: "Áo thun - đen - M", quantity: 2, unit_price: 150000 }],
            total: 300000,
            payment: "cod",
            note: "",
          },
        },
      ];
      stopReason = "tool_use";
    } else if (mode === "refusal") {
      content = [];
      stopReason = "refusal";
    } else {
      content = [{ type: "text", text: "Dạ em đã lưu đơn hàng cho anh/chị ạ!" }];
      stopReason = "end_turn";
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      })
    );
  });
});

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log("\n🧠 FB Sales Bot — Claude tool-loop test (mock API)\n");

  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const port = (mock.address() as any).port;
  process.env.BOT_ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

  // Import AFTER env is set so config picks it up.
  const { generateReply } = await import("../src/claude");
  const { findOrders } = await import("../src/store");

  // ── Turn 1: model calls save_order, then replies ──────────────────────────
  const result = await generateReply("test-psid", "Mình chốt 2 áo đen size M nhé");
  assert(result.text.includes("đơn"), `final reply returned: "${result.text}"`);

  const first = requests[0];
  assert(first.model === "claude-opus-5-5", "model = claude-opus-5-5");
  assert(first.fallbacks === "default", "fallbacks = default");
  assert(first.thinking?.type === "adaptive", "thinking = adaptive");
  assert(first.output_config?.effort === "low", "effort = low");
  assert(
    typeof first.system?.[0]?.text === "string" &&
      first.system[0].text.includes("KIẾN THỨC CỬA HÀNG"),
    "system prompt contains the knowledge block"
  );
  assert(
    first.system?.[0]?.cache_control?.ttl === "1h",
    "system prompt has 1h cache_control"
  );
  assert(
    Array.isArray(first.tools) && first.tools.some((t: any) => t.name === "save_order"),
    "tools include save_order"
  );

  const second = requests[1];
  const toolResult = (second?.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .find((b: any) => b.type === "tool_result");
  assert(Boolean(toolResult), "second request carries the tool_result");
  assert(toolResult?.tool_use_id === "toolu_1", "tool_result matches tool_use_id");

  const order = findOrders({ id: 1 })[0];
  assert(Boolean(order && order.name === "Khách Test"), "order was saved to SQLite #1");

  // ── Turn 2: refusal → apology, history stays valid ────────────────────────
  mode = "refusal";
  const refused = await generateReply("test-psid", "Một yêu cầu không phù hợp");
  assert(refused.text.includes("chủ shop"), `refusal returns the apology: "${refused.text}"`);

  // Cleanup the throwaway DB; real data/ is never touched.
  mock.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  console.log("\nTest data cleaned up.\n");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});

/**
 * Offline test of the order pipeline: validation → SQLite → CSV → status lookup.
 * Uses a throwaway data directory, so it never touches real orders and leaves
 * nothing behind.
 *
 * Run: npm run test:order
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Dummy config + isolated data dir must exist BEFORE the modules load.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fb-bot-order-test-"));
process.env.BOT_PROVIDER = "anthropic";
process.env.BOT_MODEL = ""; // use the provider default, ignore any real .env value
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.META_PAGE_ID = "123456789";
process.env.META_PAGE_TOKEN = "dummy-token";
process.env.META_APP_ID = "111";
process.env.META_APP_SECRET = "testsecret";
process.env.META_VERIFY_TOKEN = "verify123";
process.env.OWNER_SETUP_CODE = "TEST-CODE-9876";
process.env.NOTIFY_URL = ""; // never send real pushes from an offline test
process.env.WEBHOOK_PUBLIC_URL = "";
process.env.BOT_DATA_DIR = TEST_DATA_DIR;

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log("\n🧾 FB Sales Bot — order pipeline test\n");

  // Import AFTER env is set so config picks up the test data dir.
  const { executeTool, syncOrdersCsv } = await import("../src/orders");
  const { findOrders, updateOrderStatus } = await import("../src/store");
  const { paths } = await import("../src/config");

  assert(paths.db.startsWith(TEST_DATA_DIR), "using an isolated data directory");

  const ctx = { psid: "test-user-123" };

  // ── Save a valid order ────────────────────────────────────────────────────
  const saved = await executeTool(
    "save_order",
    {
      customer_name: "Khách Test",
      phone: "0901234567",
      address: "123 Đường Test, Phường 1, Quận 1, TP.HCM",
      items: [
        { product: "Áo thun basic cotton - đen - M", quantity: 2, unit_price: 150000 },
        { product: "Quần jogger - navy - L", quantity: 1, unit_price: 220000 },
      ],
      total: 520000,
      payment: "cod",
      note: "Giao giờ hành chính",
    },
    ctx
  );
  const idMatch = saved.match(/#(\d+)/);
  assert(Boolean(idMatch), `save_order returned an order number: "${saved}"`);
  if (!idMatch) throw new Error("Order was not saved!");
  const id = Number(idMatch[1]);

  // ── SQLite row ────────────────────────────────────────────────────────────
  const row = findOrders({ id })[0];
  assert(
    Boolean(
      row &&
        row.name === "Khách Test" &&
        row.phone === "0901234567" &&
        row.total === 520000 &&
        row.status === "Mới"
    ),
    "order stored in SQLite with correct fields"
  );
  assert(
    Boolean(row && JSON.parse(row.items_json).length === 2),
    "both line items stored in SQLite"
  );

  // ── CSV (UTF-8 BOM for Excel, Vietnamese preserved) ───────────────────────
  const csv = fs.readFileSync(paths.ordersCsv, "utf8");
  assert(csv.startsWith("﻿"), "orders.csv starts with a UTF-8 BOM");
  assert(
    csv.includes("Khách Test") && csv.includes("Áo thun basic cotton - đen - M x2"),
    "orders.csv contains the customer and the items"
  );

  // ── Status lookup by order id and by phone ────────────────────────────────
  const byId = await executeTool("get_order_status", { order_id: id, phone: "" }, ctx);
  assert(byId.includes(`Đơn #${id}: Mới`), `status lookup by order id: "${byId}"`);

  const byPhone = await executeTool(
    "get_order_status",
    { order_id: 0, phone: "0901234567" },
    ctx
  );
  assert(byPhone.includes(`Đơn #${id}`), "status lookup by phone finds the same order");

  const missing = await executeTool("get_order_status", { order_id: 99999, phone: "" }, ctx);
  assert(missing.startsWith("Không tìm thấy đơn hàng"), "unknown order id is reported cleanly");

  // ── Owner status update + CSV resync ──────────────────────────────────────
  assert(updateOrderStatus(id, "Đã gửi hàng"), "owner can update the order status");
  syncOrdersCsv();
  const csvAfter = fs.readFileSync(paths.ordersCsv, "utf8");
  assert(csvAfter.includes("Đã gửi hàng"), "orders.csv reflects the new status after resync");
  const after = await executeTool("get_order_status", { order_id: id, phone: "" }, ctx);
  assert(after.includes(`Đơn #${id}: Đã gửi hàng`), "status lookup returns the updated status");

  // ── Invalid order is rejected, nothing written ────────────────────────────
  const invalid = await executeTool(
    "save_order",
    {
      customer_name: "Khách Test",
      phone: "123",
      address: "x",
      items: [],
      total: 0,
      payment: "cod",
      note: "",
    },
    ctx
  );
  assert(invalid.startsWith("KHÔNG lưu được đơn"), "invalid order rejected (short phone, no items, total 0)");
  assert(findOrders({ phone: "123" }).length === 0, "rejected order was not written to SQLite");

  // ── Cleanup ───────────────────────────────────────────────────────────────
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  console.log("\nTest data cleaned up. (Real data/ was never touched.)\n");
}

main().catch((err) => {
  console.error("❌ Order test failed:", err);
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});

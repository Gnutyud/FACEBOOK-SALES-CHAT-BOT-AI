import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, paths } from "./config";
import { allOrders, createOrder, findOrders, type OrderRow } from "./store";
import { notifyOwner } from "./notify";
import { sendImage } from "./meta";

/* ------------------------------ tool definitions --------------------------- */

export const saveOrderTool: Anthropic.Beta.BetaTool = {
  name: "save_order",
  description:
    "Lưu một đơn hàng MỚI sau khi khách đã xác nhận đầy đủ thông tin (tên, SĐT, địa chỉ, sản phẩm, tổng tiền, hình thức thanh toán). Chỉ gọi khi khách đã đồng ý chốt đơn và xác nhận lại thông tin.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      customer_name: { type: "string", description: "Tên người nhận hàng" },
      phone: { type: "string", description: "Số điện thoại người nhận" },
      address: {
        type: "string",
        description: "Địa chỉ nhận hàng đầy đủ (số nhà, đường, phường/xã, quận/huyện, tỉnh/thành)",
      },
      items: {
        type: "array",
        description: "Danh sách sản phẩm khách mua",
        items: {
          type: "object",
          properties: {
            product: { type: "string", description: "Tên sản phẩm (kèm phân loại/size/màu nếu có)" },
            quantity: { type: "integer", description: "Số lượng", minimum: 1 },
            unit_price: {
              type: "integer",
              description: "Đơn giá VND. Dùng 0 nếu không chắc đơn giá.",
              minimum: 0,
            },
          },
          required: ["product", "quantity", "unit_price"],
          additionalProperties: false,
        },
      },
      total: {
        type: "integer",
        description: "Tổng tiền khách phải trả, đơn vị VND (đã gồm phí ship nếu có)",
        minimum: 0,
      },
      payment: {
        type: "string",
        enum: ["cod", "bank_transfer"],
        description: "cod = thanh toán khi nhận hàng; bank_transfer = chuyển khoản trước",
      },
      note: {
        type: "string",
        description: "Ghi chú thêm (màu/size, giờ giao, yêu cầu riêng). Dùng chuỗi rỗng nếu không có.",
      },
    },
    required: ["customer_name", "phone", "address", "items", "total", "payment", "note"],
    additionalProperties: false,
  },
};

export const getOrderStatusTool: Anthropic.Beta.BetaTool = {
  name: "get_order_status",
  description:
    "Tra cứu trạng thái đơn hàng theo mã đơn hoặc số điện thoại. Truyền order_id = 0 nếu khách chỉ cho số điện thoại; truyền phone = \"\" nếu khách chỉ cho mã đơn.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      order_id: {
        type: "integer",
        description: "Mã đơn hàng (số). Dùng 0 nếu không có.",
        minimum: 0,
      },
      phone: {
        type: "string",
        description: "Số điện thoại đặt hàng. Dùng chuỗi rỗng nếu không có.",
      },
    },
    required: ["order_id", "phone"],
    additionalProperties: false,
  },
};

export const handoverToOwnerTool: Anthropic.Beta.BetaTool = {
  name: "handover_to_owner",
  description:
    "Chuyển cuộc trò chuyện cho chủ shop (người thật) khi khách tức giận, khiếu nại, yêu cầu gặp người thật, hoặc đòi ưu đãi vượt quá quy tắc. Sau khi gọi, bạn không còn tự trả lời cuộc trò chuyện này.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Lý do ngắn gọn để chủ shop biết cần hỗ trợ gì" },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

export const notifyOwnerTool: Anthropic.Beta.BetaTool = {
  name: "notify_owner",
  description:
    "Báo cho chủ shop khi khách hỏi thông tin chưa có trong knowledge.md (nguồn gốc, chất liệu, tồn kho đặc biệt...) hoặc cần chủ shop xác nhận. KHÔNG chuyển cuộc trò chuyện và KHÔNG tạm dừng bot. Sau khi gọi, hãy nói khách là em sẽ kiểm tra và báo lại, rồi tiếp tục tư vấn bình thường.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Nội dung ngắn gọn cần chủ shop xác nhận" },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

export const sendProductImagesTool: Anthropic.Beta.BetaTool = {
  name: "send_product_images",
  description:
    "Gửi ảnh sản phẩm thật cho khách qua Messenger. Dùng khi khách hỏi ảnh, muốn xem mẫu, hoặc muốn xem màu cụ thể. Truyền mã sản phẩm (WF-01..WF-08) và màu nếu khách đã nêu; dùng chuỗi rỗng nếu khách không nêu màu.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      product_code: { type: "string", description: "Mã sản phẩm, ví dụ WF-02" },
      color: {
        type: "string",
        description: "Màu khách muốn xem (nâu, đen, bạc...). Dùng chuỗi rỗng nếu không có.",
      },
    },
    required: ["product_code", "color"],
    additionalProperties: false,
  },
};

export const ALL_TOOLS = [
  saveOrderTool,
  getOrderStatusTool,
  handoverToOwnerTool,
  notifyOwnerTool,
  sendProductImagesTool,
];

/* ------------------------------- validation -------------------------------- */

const SaveOrderSchema = z.object({
  customer_name: z.string().min(1),
  phone: z.string().refine((p) => p.replace(/\D/g, "").length >= 8, "Số điện thoại không hợp lệ"),
  address: z.string().min(5),
  items: z
    .array(
      z.object({
        product: z.string().min(1),
        quantity: z.number().int().positive(),
        unit_price: z.number().int().nonnegative().optional(),
      })
    )
    .min(1),
  total: z.number().int().positive(),
  payment: z.enum(["cod", "bank_transfer"]),
  note: z.string().optional(),
});

/* --------------------------------- CSV ------------------------------------- */

const CSV_HEADER =
  "Mã đơn,Thời gian,Tên,SĐT,Địa chỉ,Sản phẩm,Tổng tiền,Thanh toán,Trạng thái\n";

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function orderCsvLine(row: OrderRow): string {
  const items = JSON.parse(row.items_json) as { product: string; quantity: number }[];
  const itemText = items.map((i) => `${i.product} x${i.quantity}`).join("; ");
  return [
    String(row.id),
    new Date(row.created_at).toLocaleString("vi-VN"),
    row.name,
    row.phone,
    row.address,
    itemText,
    String(row.total),
    row.payment === "cod" ? "COD" : "Chuyển khoản",
    row.status,
  ]
    .map((v) => csvEscape(v))
    .join(",");
}

function appendOrderCsv(row: OrderRow): void {
  if (!fs.existsSync(paths.ordersCsv)) {
    fs.writeFileSync(paths.ordersCsv, "﻿" + CSV_HEADER, "utf8");
  }
  fs.appendFileSync(paths.ordersCsv, orderCsvLine(row) + "\n", "utf8");
}

/** Rewrite the whole CSV from SQLite (keeps statuses in sync after owner updates). */
export function syncOrdersCsv(): void {
  const lines = allOrders().map(orderCsvLine).join("\n");
  fs.writeFileSync(paths.ordersCsv, "﻿" + CSV_HEADER + (lines ? lines + "\n" : ""), "utf8");
}

/* -------------------------------- execution -------------------------------- */

export interface ToolContext {
  psid: string;
  /** Set by handover_to_owner; the caller pauses the thread afterwards. */
  handover?: { reason: string };
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<string> {
  switch (name) {
    case "save_order":
      return saveOrder(input, ctx.psid);
    case "get_order_status":
      return orderStatus(input);
    case "handover_to_owner": {
      const reason =
        (input as { reason?: string })?.reason?.trim() || "Khách cần hỗ trợ từ chủ shop";
      ctx.handover = { reason };
      return "Đã chuyển cuộc trò chuyện cho chủ shop. Hãy báo khách chủ shop sẽ trả lời ngay.";
    }
    case "notify_owner": {
      const message =
        (input as { message?: string })?.message?.trim() ||
        "Khách cần chủ shop xác nhận thông tin";
      await notifyOwner(`🙋 Khách cần xác nhận (${ctx.psid})\n${message}`).catch(() => {});
      return "Đã báo chủ shop. Hãy nói với khách là em sẽ kiểm tra và báo lại ngay, sau đó tiếp tục tư vấn các nội dung khác. KHÔNG chuyển cuộc trò chuyện.";
    }
    case "send_product_images":
      return sendProductImages(input, ctx.psid);
    default:
      return `Công cụ không tồn tại: ${name}`;
  }
}

async function saveOrder(input: unknown, psid: string): Promise<string> {
  const parsed = SaveOrderSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return `KHÔNG lưu được đơn — dữ liệu chưa hợp lệ (${detail}). Hãy hỏi lại khách thông tin còn thiếu hoặc sai.`;
  }
  const d = parsed.data;
  const id = createOrder({
    psid,
    name: d.customer_name,
    address: d.address,
    phone: d.phone,
    items: d.items,
    total: d.total,
    payment: d.payment,
    note: d.note,
  });

  const row = findOrders({ id })[0];
  if (row) appendOrderCsv(row);

  const itemsText = d.items.map((i) => `${i.product} x${i.quantity}`).join(", ");
  await notifyOwner(
    `🛒 Đơn mới #${id}\n${d.customer_name} — ${d.phone}\n${d.address}\n${itemsText}\nTổng: ${d.total.toLocaleString("vi-VN")}đ — ${
      d.payment === "cod" ? "COD" : "Chuyển khoản"
    }`
  ).catch(() => {});

  return `Đã lưu đơn hàng #${id}. Hãy xác nhận với khách: mã đơn #${id}, tổng ${d.total.toLocaleString(
    "vi-VN"
  )}đ, và thời gian giao dự kiến theo kiến thức cửa hàng.`;
}

/* ------------------------------ product images ----------------------------- */

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/** Lowercase + strip Vietnamese diacritics so `nâu` matches `nau` in filenames. */
function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/**
 * Send the photos that belong to a product code. Files live in assets/images and
 * are named after the SKU, e.g. `wf-02.jpg`, `wf-02-nau.jpg`, `wf-02-den.jpg`.
 */
async function sendProductImages(input: unknown, psid: string): Promise<string> {
  const raw = input as { product_code?: string; color?: string };
  const code = normalizeText(raw?.product_code ?? "").replace(/^wf\s*[-_]?\s*/, "wf-");
  if (!/^wf-\d{1,2}$/.test(code)) {
    return "Mã sản phẩm không hợp lệ. Hãy dùng mã như WF-01, WF-02…";
  }
  if (!fs.existsSync(paths.images)) {
    return "Shop chưa có ảnh sản phẩm. Hãy báo khách chờ chủ shop gửi ảnh.";
  }

  const files = fs
    .readdirSync(paths.images)
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .filter((f) => normalizeText(f).startsWith(code))
    .sort();

  const colorTokens = normalizeText(raw?.color ?? "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  const colorMatches = colorTokens.length
    ? files.filter((f) => colorTokens.some((t) => normalizeText(f).includes(t)))
    : [];
  const selected = (colorMatches.length ? colorMatches : files).slice(0, 4);

  if (selected.length === 0) {
    return `Chưa có ảnh cho mẫu ${code.toUpperCase()}. Hãy báo khách chờ chủ shop gửi ảnh.`;
  }
  if (!config.WEBHOOK_PUBLIC_URL) {
    return "Chưa cấu hình WEBHOOK_PUBLIC_URL nên không gửi được ảnh. Hãy báo khách chờ chủ shop.";
  }

  const base = config.WEBHOOK_PUBLIC_URL.replace(/\/$/, "");
  let sent = 0;
  for (const file of selected) {
    try {
      await sendImage(psid, `${base}/images/${encodeURIComponent(file)}`);
      sent++;
    } catch (err) {
      console.error(`[images] send failed for ${file}:`, err);
    }
  }
  if (sent === 0) {
    return "Không gửi được ảnh lúc này. Hãy báo khách chờ chủ shop gửi ảnh.";
  }
  return `Đã gửi ${sent} ảnh của mẫu ${code.toUpperCase()} cho khách. Hãy hỏi khách muốn xem thêm mẫu/màu nào khác.`;
}

function orderStatus(input: unknown): string {
  const raw = input as { order_id?: number; phone?: string };
  const orderId = Number(raw?.order_id ?? 0);
  const phone = (raw?.phone ?? "").trim();
  const rows = findOrders({
    id: orderId > 0 ? orderId : undefined,
    phone: orderId > 0 ? undefined : phone || undefined,
  });
  if (rows.length === 0) {
    return "Không tìm thấy đơn hàng. Hãy xin khách mã đơn hoặc số điện thoại đã đặt hàng.";
  }
  return rows
    .map(
      (r) =>
        `Đơn #${r.id}: ${r.status} — ${r.name}, ${r.phone}, tổng ${r.total.toLocaleString("vi-VN")}đ, đặt lúc ${new Date(
          r.created_at
        ).toLocaleDateString("vi-VN")}`
    )
    .join("\n");
}

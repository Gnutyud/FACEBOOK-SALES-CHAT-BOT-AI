import fs from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { paths } from "./config";
import { allOrders, createOrder, findOrders, type OrderRow } from "./store";
import { notifyOwner } from "./notify";

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

export const ALL_TOOLS = [saveOrderTool, getOrderStatusTool, handoverToOwnerTool];

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

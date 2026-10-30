import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { config } from "./config";
import {
  canPmFromComment,
  getConversation,
  getOwnerPsid,
  isBotEnabled,
  isPaused,
  isSentByBot,
  markPmFromComment,
  markSeen,
  pausedPsids,
  pauseThread,
  resumeThread,
  setBotEnabled,
  setOwnerPsid,
  updateOrderStatus,
} from "./store";
import { syncOrdersCsv } from "./orders";
import {
  GraphError,
  PAGE_INBOX_APP_ID,
  replyToComment,
  sendLongMessage,
  sendMessage,
  sendPrivateReply,
  sendTypingOn,
  takeThreadControl,
} from "./meta";
import { generateCommentReply, generateReply } from "./claude";
import { handToOwner, handleEcho } from "./handover";
import { notifyOwner } from "./notify";

export const webhookRouter = express.Router();

/* ------------------------------ per-thread queue --------------------------- */

const queues = new Map<string, Promise<void>>();

function enqueue(key: string, job: () => Promise<void>): void {
  const prev = queues.get(key) ?? Promise.resolve();
  const next: Promise<void> = prev
    .then(job, job)
    .catch((err) => console.error(`[queue:${key}]`, err))
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  queues.set(key, next);
}

/* ------------------------------ verification ------------------------------- */

webhookRouter.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.META_VERIFY_TOKEN) {
    console.log("[webhook] verified by Meta");
    res.status(200).type("text/plain").send(String(challenge ?? ""));
    return;
  }
  console.warn("[webhook] verification failed (bad verify token)");
  res.sendStatus(403);
});

/* -------------------------------- receiving -------------------------------- */

webhookRouter.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  (req: Request, res: Response) => {
    const raw = req.body as Buffer;

    if (!verifySignature(raw, req.header("x-hub-signature-256"))) {
      console.warn("[webhook] bad or missing signature — rejected");
      res.sendStatus(401);
      return;
    }

    // Meta requires a fast 200; process asynchronously.
    res.status(200).type("text/plain").send("EVENT_RECEIVED");

    let payload: any;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      console.error("[webhook] invalid JSON body");
      return;
    }

    setImmediate(() => {
      processPayload(payload).catch((err) =>
        console.error("[webhook] processing error:", err)
      );
    });
  }
);

function verifySignature(raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = crypto
    .createHmac("sha256", config.META_APP_SECRET)
    .update(raw)
    .digest("hex");
  const received = header.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/* -------------------------------- dispatching ------------------------------ */

async function processPayload(payload: any): Promise<void> {
  if (payload?.object !== "page") return;

  for (const entry of payload.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      // Thread-control events arrive in `messaging` too (field messaging_handovers).
      if (
        ev.pass_thread_control ||
        ev.take_thread_control ||
        ev.request_thread_control
      ) {
        handleHandoverEvent(ev);
      } else {
        handleMessagingEvent(ev, false);
      }
    }
    for (const ev of entry.messaging_handovers ?? []) {
      handleHandoverEvent(ev);
    }
    for (const ev of entry.standby ?? []) {
      handleMessagingEvent(ev, true);
    }
    for (const change of entry.changes ?? []) {
      if (change.field === "feed") handleFeedChange(change.value);
    }
  }
}

/* ------------------------------ messaging (DM) ----------------------------- */

function handleMessagingEvent(ev: any, isStandby: boolean): void {
  const message = ev?.message;

  // Message sent BY the page (bot, or owner typing in the Page Inbox app).
  // In echo events the sender is the Page and the recipient is the customer.
  if (message?.is_echo) {
    const threadPsid: string | undefined = ev?.recipient?.id;
    const mid: string | undefined = message.mid;
    if (threadPsid && mid && threadPsid !== config.META_PAGE_ID) {
      handleEcho(threadPsid, mid, isSentByBot(mid));
    }
    return;
  }

  const senderId: string | undefined = ev?.sender?.id;
  if (!senderId || senderId === config.META_PAGE_ID) return;

  if (!message?.mid) return; // deliveries, read receipts, etc.

  if (isStandby) {
    // Another app (Page Inbox) owns this thread. Mark it paused so "bot tiếp"
    // can reclaim control; replying now would be rejected.
    getConversation(senderId);
    pauseThread(senderId, 0);
    console.log(
      `[webhook] standby event from …${senderId.slice(-4)} — Page Inbox owns thread (paused until "bot tiếp")`
    );
    return;
  }

  const mid: string = message.mid;
  if (!markSeen(mid)) return; // duplicate delivery

  const text: string | undefined = message.text?.trim();

  enqueue(`dm:${senderId}`, async () => {
    try {
      await handleIncomingText(senderId, text, message.attachments?.length > 0);
    } catch (err) {
      console.error(`[webhook] failed handling DM from ${senderId}:`, err);
    }
  });
}

/**
 * A thread paused by a handover or owner takeover auto-resumes when its timer
 * expires. Reclaim thread control from Page Inbox first, otherwise Meta rejects
 * the bot's outgoing messages.
 */
async function resumeExpiredThread(psid: string): Promise<boolean> {
  const conv = getConversation(psid);
  if (conv.state !== "paused") return true;
  if (conv.pausedUntil === 0 || conv.pausedUntil > Date.now()) {
    console.log(
      `[webhook] DM from …${psid.slice(-4)} ignored — thread paused${
        conv.pausedUntil
          ? ` until ${new Date(conv.pausedUntil).toLocaleString("vi-VN")}`
          : " (manual)"
      }`
    );
    return false;
  }
  await takeThreadControl(psid).catch(() => {});
  resumeThread(psid);
  console.log(`[handover] auto-resumed thread ${psid}`);
  return true;
}

async function handleIncomingText(
  psid: string,
  text: string | undefined,
  hasAttachments: boolean
): Promise<void> {
  console.log(
    `[webhook] DM from …${psid.slice(-4)} (${text ? `${text.length} chars` : "no text"})`
  );

  // Owner enrolment: first message that matches the setup code becomes the owner.
  if (text && !getOwnerPsid() && text.trim().toUpperCase() === config.OWNER_SETUP_CODE.toUpperCase()) {
    setOwnerPsid(psid);
    await sendMessage(
      psid,
      "✅ Đã ghi nhận anh/chị là chủ shop. Từ giờ bot sẽ gửi thông báo đơn hàng và yêu cầu hỗ trợ về đây ạ."
    ).catch(() => {});
    console.log(`[owner] owner PSID captured: ${psid}`);
    return;
  }

  const owner = getOwnerPsid();
  if (owner && psid === owner) {
    console.log("[webhook] message from owner — handled as owner message (no auto-reply)");
    await handleOwnerMessage(psid, text ?? "");
    return;
  }

  if (!isBotEnabled()) {
    console.log(`[webhook] DM from …${psid.slice(-4)} ignored — bot disabled`);
    return;
  }
  if (!(await resumeExpiredThread(psid))) return;

  if (!text) {
    if (hasAttachments) {
      await sendMessage(
        psid,
        "Dạ em hiện chỉ đọc được tin nhắn chữ thôi ạ. Anh/chị nhắn giúp em bằng chữ để em tư vấn ngay nhé ạ!"
      ).catch(() => {});
    }
    return;
  }

  await sendTypingOn(psid).catch(() => {});

  const result = await generateReply(psid, text);
  await sendLongMessage(psid, result.text).catch(async (err) => {
    console.error(`[webhook] send failed for ${psid}:`, err);
    if (err instanceof GraphError) {
      await notifyOwner(
        `⚠️ Không gửi được tin cho khách ${psid} (có thể quá 24h). Khách nhắn: "${text}"`
      ).catch(() => {});
    }
  });

  if (result.handover) {
    await handToOwner(psid, result.handover.reason);
  }
}

/* ------------------------------ owner commands ----------------------------- */

async function handleOwnerMessage(psid: string, text: string): Promise<void> {
  const t = text.trim();

  if (/^(?:bot\s*(?:off|tắt|tat)|(?:tắt|tat)\s*bot)$/i.test(t)) {
    setBotEnabled(false);
    await sendMessage(psid, "🔕 Đã TẮT bot. Tất cả tin nhắn khách sẽ chờ chủ shop trả lời.").catch(
      () => {}
    );
    return;
  }
  if (/^(?:bot\s*(?:on|bật|bat)|(?:bật|bat)\s*bot)$/i.test(t)) {
    setBotEnabled(true);
    await sendMessage(psid, "🔔 Đã BẬT bot trở lại.").catch(() => {});
    return;
  }
  if (/^bot\s*(tiếp|tiep|resume)/i.test(t)) {
    const psids = pausedPsids();
    let reclaimed = 0;
    for (const p of psids) {
      try {
        await takeThreadControl(p);
        reclaimed++;
      } catch (err) {
        console.error(`[handover] could not take control of …${p.slice(-4)}:`, err);
      }
      resumeThread(p);
    }
    await sendMessage(
      psid,
      `▶️ Đã tiếp tục ${psids.length} cuộc trò chuyện (lấy lại quyền: ${reclaimed}).` +
        (reclaimed < psids.length
          ? "\n⚠️ Một số thread vẫn do Page Inbox giữ. Hãy đặt Chat bot làm default app trong Conversation Routing."
          : "")
    ).catch(() => {});
    return;
  }

  const orderMatch = t.match(/^(?:đơn|don)\s*#?(\d+)\s+(.+)$/i);
  if (orderMatch) {
    const id = Number(orderMatch[1]);
    const status = orderMatch[2].trim();
    const ok = updateOrderStatus(id, status);
    if (ok) syncOrdersCsv();
    await sendMessage(
      psid,
      ok ? `✅ Đã cập nhật đơn #${id}: ${status}` : `❌ Không tìm thấy đơn #${id}`
    ).catch(() => {});
    return;
  }

  // Any other message from the owner is just a note-to-self; no reply.
}

/* --------------------------------- comments -------------------------------- */

function handleFeedChange(value: any): void {
  if (!value || value.item !== "comment") return;
  if (value.verb !== "add") return;

  // Newer payloads use value.from; older ones use value.sender_id.
  const fromId: string | undefined = value.from?.id ?? value.sender_id;
  const fromName: string | undefined = value.from?.name ?? value.sender_name;
  const commentId: string | undefined = value.comment_id;
  const message: string = (value.message ?? "").trim();

  if (!fromId || fromId === config.META_PAGE_ID) return;
  if (!commentId || !message) return;

  if (!markSeen(commentId)) return; // duplicate delivery

  enqueue(`comment:${fromId}`, async () => {
    try {
      await handleComment(fromId, commentId, message, fromName);
    } catch (err) {
      console.error(`[webhook] failed handling comment ${commentId}:`, err);
    }
  });
}

async function handleComment(
  fromId: string,
  commentId: string,
  message: string,
  fromName?: string
): Promise<void> {
  if (!isBotEnabled()) return;
  if (isPaused(fromId)) return;

  const reply = await generateCommentReply(message);

  await replyToComment(commentId, reply).catch((err) =>
    console.error(`[webhook] comment reply failed (${commentId}):`, err)
  );

  // One private reply per comment is allowed within 7 days; we cap to 1 PM / 7 days per person.
  if (canPmFromComment(fromId)) {
    const dmText = `${fromName ? `Chào ${fromName}! ` : "Chào bạn! "}Cảm ơn bạn đã quan tâm sản phẩm của shop ạ.\n\n${reply}\n\nBạn nhắn tin cho shop ở đây để em tư vấn kỹ hơn và chốt đơn nhé ạ!`;
    try {
      await sendPrivateReply(commentId, dmText);
      markPmFromComment(fromId, commentId);
    } catch (err) {
      console.error(`[webhook] private reply failed (${commentId}):`, err);
    }
  }
}

/* -------------------------------- handovers -------------------------------- */

function handleHandoverEvent(ev: any): void {
  const psid: string | undefined = ev?.sender?.id;
  if (!psid) return;

  const newOwner = ev.pass_thread_control?.new_owner_app_id;
  if (String(newOwner) === String(config.META_APP_ID)) {
    // Control came back to the bot (e.g. owner marked the chat "Done").
    resumeThread(psid);
    console.log(`[handover] bot regained control of ${psid}`);
    return;
  }
  if (String(newOwner) === PAGE_INBOX_APP_ID) {
    // Control moved to the Page Inbox app — the owner is handling this thread.
    // Auto-resume after 24h as a safety net; "bot tiếp" resumes immediately.
    pauseThread(psid, Date.now() + 24 * 60 * 60 * 1000);
    console.log(`[handover] thread ${psid} now owned by Page Inbox`);
  }
}

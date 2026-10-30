import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { getSystemPrompt } from "./prompt";
import { getConversation, saveHistory } from "./store";
import { ALL_TOOLS, executeTool, type ToolContext } from "./orders";

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

// Pin the official endpoint and API key so unrelated ANTHROPIC_* variables in the
// owner's shell (proxies, coding tools) can never hijack the bot's traffic.
// BOT_ANTHROPIC_BASE_URL exists only for the offline test suite.
const client = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  baseURL: config.BOT_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
});

const MAX_TOOL_ROUNDS = 6;

const CANNED_ERROR =
  "Dạ em xin lỗi, hệ thống đang bận một chút. Anh/chị nhắn lại giúp em sau ít phút nhé ạ 🙏";

function systemParam() {
  return [
    {
      type: "text" as const,
      text: getSystemPrompt(),
      cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
    },
  ];
}

function baseRequest() {
  return {
    model: config.BOT_MODEL,
    max_tokens: 4096,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const,
    thinking: { type: "adaptive" as const },
    output_config: { effort: config.BOT_EFFORT },
    system: systemParam(),
  };
}

function logUsage(response: Anthropic.Beta.BetaMessage): void {
  const u = response.usage as any;
  console.log(
    `[claude] stop=${response.stop_reason} in=${u?.input_tokens ?? 0} out=${
      u?.output_tokens ?? 0
    } cache_read=${u?.cache_read_input_tokens ?? 0} cache_write=${
      u?.cache_creation_input_tokens ?? 0
    }`
  );
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/* ------------------------------ customer reply ----------------------------- */

export interface ReplyResult {
  text: string;
  handover?: { reason: string };
}

/**
 * Generate a reply to a customer DM, with tools and full conversation history.
 * Persists the conversation state (including tool exchanges) to SQLite.
 */
export async function generateReply(psid: string, customerText: string): Promise<ReplyResult> {
  const conv = getConversation(psid);
  const messages: Msg[] = [...conv.history, { role: "user", content: customerText }];

  if (config.DRY_RUN) {
    const canned = `[DRY_RUN] Em đã nhận tin nhắn: "${customerText}". (Bot đang ở chế độ thử nghiệm, chưa gọi Claude.)`;
    messages.push({ role: "assistant", content: canned });
    saveHistory(psid, messages);
    return { text: canned };
  }

  const ctx: ToolContext = { psid };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        ...baseRequest(),
        tools: ALL_TOOLS,
        messages,
      });
    } catch (err) {
      console.error(`[claude] API error for ${psid}:`, err);
      // Keep what we have (including the customer's message) so context isn't lost.
      saveHistory(psid, messages);
      return { text: CANNED_ERROR };
    }

    logUsage(response);
    messages.push({
      role: "assistant",
      content: response.content as unknown as Block[],
    });

    if (response.stop_reason === "refusal") {
      const apology =
        "Dạ em chưa hỗ trợ được nội dung này ạ. Anh/chị để em chuyển chủ shop hỗ trợ ngay nhé ạ.";
      // Replace the refused (possibly empty) turn with what the customer actually saw.
      messages[messages.length - 1] = { role: "assistant", content: apology };
      saveHistory(psid, messages);
      return { text: apology };
    }

    if (response.stop_reason === "tool_use") {
      const results: Block[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const output = await executeTool(block.name, block.input, ctx);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output,
          });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    const text = textOf(response.content);
    saveHistory(psid, messages);
    return {
      text: text || "Dạ em đã ghi nhận, anh/chị cho em xin thêm thông tin nhé ạ.",
      handover: ctx.handover,
    };
  }

  console.error(`[claude] tool loop limit reached for ${psid}`);
  saveHistory(psid, messages);
  return { text: "Dạ em cần kiểm tra thêm với chủ shop, em sẽ phản hồi anh/chị ngay ạ." };
}

/* ------------------------------ comment reply ------------------------------ */

const PUBLIC_REPLY_FALLBACK =
  "Dạ shop có sẵn ạ, anh/chị nhắn tin cho shop để em tư vấn kỹ hơn nhé ạ!";

/**
 * Short public reply to a post comment. No tools, no history, not persisted.
 */
export async function generateCommentReply(commentText: string): Promise<string> {
  if (config.DRY_RUN) {
    return `[DRY_RUN] Cảm ơn bạn đã bình luận: "${commentText}". Shop nhắn tin tư vấn thêm nhé!`;
  }

  const instruction = `# CHẾ ĐỘ TRẢ LỜI BÌNH LUẬN CÔNG KHAI
Khách vừa bình luận công khai trên bài viết của shop: "${commentText.replace(/"/g, "'")}"

Viết MỘT câu trả lời công khai thật ngắn (tối đa 2 câu), thân thiện, chỉ dùng thông tin trong phần kiến thức cửa hàng.
Quy tắc: không hỏi thông tin cá nhân (địa chỉ, SĐT), không chốt đơn trong bình luận công khai, và mời khách nhắn tin cho shop để được tư vấn. Không dùng markdown.`;

  try {
    const response = await client.beta.messages.create({
      ...baseRequest(),
      max_tokens: 1500,
      messages: [{ role: "user", content: instruction }],
    });
    logUsage(response);
    return textOf(response.content) || PUBLIC_REPLY_FALLBACK;
  } catch (err) {
    console.error("[claude] comment reply error:", err);
    return PUBLIC_REPLY_FALLBACK;
  }
}

import { config } from "./config";
import { markSent } from "./store";

export const PAGE_INBOX_APP_ID = "263902037430900";

const GRAPH = `https://graph.facebook.com/${config.GRAPH_API_VERSION}`;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number
  ) {
    super(message);
    this.name = "GraphError";
  }
}

async function graph<T>(
  path: string,
  opts: { method?: "GET" | "POST"; query?: Record<string, string>; body?: unknown } = {}
): Promise<T> {
  const url = new URL(`${GRAPH}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("access_token", config.META_PAGE_TOKEN);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON response */
  }

  if (!res.ok || data?.error) {
    const err = data?.error ?? {};
    throw new GraphError(
      `Graph API ${path} failed: ${err.message ?? res.statusText}`,
      res.status,
      err.code,
      err.error_subcode
    );
  }
  return data as T;
}

/* --------------------------------- sending -------------------------------- */

export async function sendMessage(psid: string, text: string): Promise<void> {
  const res = await graph<{ message_id?: string }>(`/${config.META_PAGE_ID}/messages`, {
    body: {
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message: { text },
    },
  });
  if (res.message_id) markSent(res.message_id);
}

/** Send an image by public HTTPS URL (Meta fetches it, so it must be reachable). */
export async function sendImage(psid: string, url: string): Promise<void> {
  const res = await graph<{ message_id?: string }>(`/${config.META_PAGE_ID}/messages`, {
    body: {
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "image", payload: { url } } },
    },
  });
  if (res.message_id) markSent(res.message_id);
}

export async function sendTypingOn(psid: string): Promise<void> {
  await graph(`/${config.META_PAGE_ID}/messages`, {
    body: { recipient: { id: psid }, sender_action: "typing_on" },
  });
}

/** Split text on Messenger's 2000-char limit (prefer line breaks). */
export function chunkText(text: string, limit = 1900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendLongMessage(psid: string, text: string): Promise<void> {
  for (const chunk of chunkText(text)) {
    await sendMessage(psid, chunk);
  }
}

/* --------------------------------- comments ------------------------------- */

/** Public (threaded) reply to a comment. */
export async function replyToComment(commentId: string, message: string): Promise<void> {
  await graph(`/${commentId}/comments`, { body: { message } });
}

/**
 * One-shot private reply to the author of a comment (valid 7 days, once per comment).
 * Opens a Messenger thread with that person.
 */
export async function sendPrivateReply(commentId: string, text: string): Promise<void> {
  const res = await graph<{ message_id?: string }>(`/${config.META_PAGE_ID}/messages`, {
    body: {
      recipient: { comment_id: commentId },
      messaging_type: "RESPONSE",
      message: { text },
    },
  });
  if (res.message_id) markSent(res.message_id);
}

/* --------------------------------- handover -------------------------------- */

export async function passThreadControl(
  psid: string,
  metadata = "handover_to_owner"
): Promise<void> {
  await graph(`/${config.META_PAGE_ID}/pass_thread_control`, {
    body: { recipient: { id: psid }, target_app_id: PAGE_INBOX_APP_ID, metadata },
  });
}

export async function takeThreadControl(psid: string): Promise<void> {
  await graph(`/${config.META_PAGE_ID}/take_thread_control`, {
    body: { recipient: { id: psid }, metadata: "bot_resume" },
  });
}

/* ------------------------------ subscriptions ------------------------------ */

const WEBHOOK_FIELDS = [
  "messages",
  "message_deliveries",
  "message_echoes",
  "messaging_handovers",
  "standby",
  "feed",
].join(",");

export async function subscribePage(): Promise<void> {
  await graph(`/${config.META_PAGE_ID}/subscribed_apps`, {
    method: "POST",
    query: { subscribed_fields: WEBHOOK_FIELDS },
  });
}

/** Register the app-level webhook (needed on first setup / when the URL changes). */
export async function updateAppWebhook(callbackUrl: string): Promise<void> {
  const url = new URL(`${GRAPH}/${config.META_APP_ID}/subscriptions`);
  const appToken = `${config.META_APP_ID}|${config.META_APP_SECRET}`;
  url.searchParams.set("access_token", appToken);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      object: "page",
      callback_url: callbackUrl,
      verify_token: config.META_VERIFY_TOKEN,
      fields: WEBHOOK_FIELDS,
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new GraphError(
      `Webhook registration failed: ${data?.error?.message ?? res.statusText}`,
      res.status,
      data?.error?.code
    );
  }
}

/* --------------------------------- lookups -------------------------------- */

export async function getPageInfo(): Promise<{ id: string; name?: string }> {
  try {
    return await graph<{ id: string; name: string }>(`/${config.META_PAGE_ID}`, {
      query: { fields: "id,name" },
    });
  } catch (err) {
    // Reading page fields needs pages_read_engagement, an optional scope the
    // bot never uses. Messenger-only tokens (the documented setup) can still
    // prove access through their own Messenger profile, so don't block on it.
    try {
      await graph(`/${config.META_PAGE_ID}/messenger_profile`);
      return { id: config.META_PAGE_ID };
    } catch {
      throw err;
    }
  }
}

export async function getUserName(psid: string): Promise<string | undefined> {
  try {
    const data = await graph<{ first_name?: string; name?: string }>(`/${psid}`, {
      query: { fields: "first_name,name" },
    });
    return data.first_name ?? data.name;
  } catch {
    return undefined;
  }
}

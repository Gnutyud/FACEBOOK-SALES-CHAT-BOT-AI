import { config } from "./config";
import { getOwnerPsid } from "./store";
import { sendMessage } from "./meta";

/**
 * Notify the owner: push via ntfy.sh (works even when the 24h window is closed),
 * then try a Messenger DM (only delivered inside the 24h window — failures ignored).
 */
export async function notifyOwner(text: string): Promise<void> {
  const jobs: Promise<unknown>[] = [];

  if (config.NOTIFY_URL) {
    jobs.push(
      fetch(config.NOTIFY_URL, {
        method: "POST",
        headers: {
          Title: "FB Sales Bot",
          Tags: "shopping",
          Priority: "default",
        },
        body: text,
      }).catch(() => {})
    );
  }

  const owner = getOwnerPsid();
  if (owner) {
    jobs.push(sendMessage(owner, text).catch(() => {}));
  }

  if (jobs.length === 0) {
    console.log(`[notify] (no channel configured) ${text}`);
    return;
  }
  await Promise.allSettled(jobs);
}

import { isPaused, pauseThread, resumeThread } from "./store";
import { passThreadControl } from "./meta";
import { notifyOwner } from "./notify";

const OWNER_PAUSE_MS = 60 * 60 * 1000; // pause 60 min after the owner answers from the phone

/** Pause auto-replies on a thread. untilMs = 0 means "until explicitly resumed". */
export function pauseForOwner(psid: string, untilMs = 0): void {
  pauseThread(psid, untilMs);
}

export function resumeForOwner(psid: string): void {
  resumeThread(psid);
}

export { isPaused };

/**
 * Echo-detection fallback (no Handover setup needed): an `is_echo` message whose
 * mid the bot did not send means the owner typed from the Page Inbox app.
 */
export function handleEcho(psid: string, mid: string, sentByBot: boolean): void {
  if (sentByBot) return;
  pauseThread(psid, Date.now() + OWNER_PAUSE_MS);
  console.log(`[handover] owner replied on ${psid}; bot paused for 60 min`);
}

/** Hand the conversation to a human and ping the owner. Auto-resumes after 24h. */
export async function handToOwner(psid: string, reason: string): Promise<void> {
  pauseForOwner(psid, Date.now() + 24 * 60 * 60 * 1000);
  try {
    await passThreadControl(psid, reason.slice(0, 500));
  } catch (err) {
    console.error(`[handover] pass_thread_control failed for ${psid}:`, err);
  }
  await notifyOwner(`🙋 Cần chủ shop hỗ trợ khách (${psid})\nLý do: ${reason}`).catch(
    () => {}
  );
}

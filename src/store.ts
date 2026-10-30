import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { config, paths } from "./config";

type Msg = Anthropic.Beta.BetaMessageParam;

fs.mkdirSync(path.dirname(paths.db), { recursive: true });

const db = new Database(paths.db);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  psid           TEXT PRIMARY KEY,
  state          TEXT NOT NULL DEFAULT 'active',
  history_json   TEXT NOT NULL DEFAULT '[]',
  paused_until   INTEGER NOT NULL DEFAULT 0,
  last_activity  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  psid        TEXT NOT NULL,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL,
  phone       TEXT NOT NULL,
  items_json  TEXT NOT NULL,
  total       INTEGER NOT NULL,
  payment     TEXT NOT NULL,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'Mới',
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_mids (
  mid TEXT PRIMARY KEY,
  ts  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sent_mids (
  mid TEXT PRIMARY KEY,
  ts  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comment_pm (
  psid       TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const now = () => Date.now();

/* ------------------------------- conversation ------------------------------ */

export interface Conversation {
  psid: string;
  state: "active" | "paused";
  history: Msg[];
  pausedUntil: number;
  lastActivity: number;
}

function getOrCreateRow(psid: string) {
  const row = db
    .prepare("SELECT * FROM conversations WHERE psid = ?")
    .get(psid) as any;
  if (row) return row;
  db.prepare(
    "INSERT INTO conversations (psid, state, history_json, paused_until, last_activity, created_at) VALUES (?, 'active', '[]', 0, ?, ?)"
  ).run(psid, now(), now());
  return db.prepare("SELECT * FROM conversations WHERE psid = ?").get(psid) as any;
}

export function getConversation(psid: string): Conversation {
  const row = getOrCreateRow(psid);
  return {
    psid,
    state: row.state === "paused" ? "paused" : "active",
    history: JSON.parse(row.history_json) as Msg[],
    pausedUntil: row.paused_until,
    lastActivity: row.last_activity,
  };
}

function trimHistory(msgs: Msg[], maxMessages = 30): Msg[] {
  if (msgs.length <= maxMessages) return msgs;
  let start = msgs.length - maxMessages;
  // Never start with a tool_result: keep advancing until a plain-text user turn.
  while (start < msgs.length) {
    const m = msgs[start];
    if (m.role === "user" && typeof m.content === "string") break;
    start++;
  }
  return start < msgs.length ? msgs.slice(start) : msgs.slice(-2);
}

export function saveHistory(psid: string, messages: Msg[]): void {
  const trimmed = trimHistory(messages);
  db.prepare(
    "UPDATE conversations SET history_json = ?, last_activity = ? WHERE psid = ?"
  ).run(JSON.stringify(trimmed), now(), psid);
}

/* --------------------------------- pause ---------------------------------- */

export function isPaused(psid: string): boolean {
  const conv = getConversation(psid);
  if (conv.state === "paused" && conv.pausedUntil > now()) return true;
  if (conv.state === "paused" && conv.pausedUntil > 0 && conv.pausedUntil <= now()) {
    // Auto-resume an expired takeover pause.
    resumeThread(psid);
    return false;
  }
  return conv.state === "paused" && conv.pausedUntil === 0;
}

export function pauseThread(psid: string, untilMs = 0): void {
  db.prepare(
    "UPDATE conversations SET state = 'paused', paused_until = ? WHERE psid = ?"
  ).run(untilMs, psid);
}

export function resumeThread(psid: string): void {
  db.prepare(
    "UPDATE conversations SET state = 'active', paused_until = 0 WHERE psid = ?"
  ).run(psid);
}

/** Resume every paused conversation (owner command "bot tiếp"). */
export function resumeAllPaused(): number {
  const res = db
    .prepare("UPDATE conversations SET state = 'active', paused_until = 0 WHERE state = 'paused'")
    .run();
  return res.changes;
}

/** PSIDs of every paused conversation. */
export function pausedPsids(): string[] {
  return (
    db.prepare("SELECT psid FROM conversations WHERE state = 'paused'").all() as {
      psid: string;
    }[]
  ).map((r) => r.psid);
}

/* ------------------------------ deduplication ----------------------------- */

/** Returns true the first time a message is seen; false for duplicates. */
export function markSeen(mid: string): boolean {
  const res = db
    .prepare("INSERT OR IGNORE INTO seen_mids (mid, ts) VALUES (?, ?)")
    .run(mid, now());
  return res.changes > 0;
}

export function markSent(mid: string): void {
  db.prepare("INSERT OR IGNORE INTO sent_mids (mid, ts) VALUES (?, ?)").run(mid, now());
}

export function isSentByBot(mid: string): boolean {
  return !!db.prepare("SELECT 1 FROM sent_mids WHERE mid = ?").get(mid);
}

/** Remove dedupe records older than 7 days. */
export function pruneDedupe(): void {
  const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM seen_mids WHERE ts < ?").run(cutoff);
  db.prepare("DELETE FROM sent_mids WHERE ts < ?").run(cutoff);
}

/* -------------------------------- settings -------------------------------- */

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getOwnerPsid(): string | undefined {
  return getSetting("owner_psid") ?? config.OWNER_PSID;
}

export function setOwnerPsid(psid: string): void {
  setSetting("owner_psid", psid);
}

export function isBotEnabled(): boolean {
  return getSetting("bot_enabled") !== "0";
}

export function setBotEnabled(enabled: boolean): void {
  setSetting("bot_enabled", enabled ? "1" : "0");
}

/* ---------------------------------- orders --------------------------------- */

export interface OrderInput {
  psid: string;
  name: string;
  address: string;
  phone: string;
  items: { product: string; quantity: number; unit_price?: number }[];
  total: number;
  payment: "cod" | "bank_transfer";
  note?: string;
}

export function createOrder(input: OrderInput): number {
  const res = db
    .prepare(
      `INSERT INTO orders (psid, name, address, phone, items_json, total, payment, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Mới', ?)`
    )
    .run(
      input.psid,
      input.name,
      input.address,
      input.phone,
      JSON.stringify(input.items),
      input.total,
      input.payment,
      input.note ?? "",
      now()
    );
  return Number(res.lastInsertRowid);
}

export interface OrderRow {
  id: number;
  psid: string;
  name: string;
  address: string;
  phone: string;
  items_json: string;
  total: number;
  payment: string;
  note: string;
  status: string;
  created_at: number;
}

export function findOrders(opts: { id?: number; phone?: string }): OrderRow[] {
  if (opts.id) {
    const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(opts.id) as
      | OrderRow
      | undefined;
    return row ? [row] : [];
  }
  if (opts.phone) {
    return db
      .prepare("SELECT * FROM orders WHERE phone = ? ORDER BY id DESC LIMIT 5")
      .all(opts.phone) as OrderRow[];
  }
  return [];
}

export function allOrders(): OrderRow[] {
  return db.prepare("SELECT * FROM orders ORDER BY id").all() as OrderRow[];
}

export function updateOrderStatus(id: number, status: string): boolean {
  const res = db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, id);
  return res.changes > 0;
}

/* ----------------------------- comment PM guard ---------------------------- */

/** True if we may send a comment private reply to this user (max once / 7 days). */
export function canPmFromComment(psid: string): boolean {
  const row = db.prepare("SELECT ts FROM comment_pm WHERE psid = ?").get(psid) as
    | { ts: number }
    | undefined;
  return !row || row.ts < now() - 7 * 24 * 60 * 60 * 1000;
}

export function markPmFromComment(psid: string, commentId: string): void {
  db.prepare(
    "INSERT INTO comment_pm (psid, comment_id, ts) VALUES (?, ?, ?) ON CONFLICT(psid) DO UPDATE SET comment_id = excluded.comment_id, ts = excluded.ts"
  ).run(psid, commentId, now());
}

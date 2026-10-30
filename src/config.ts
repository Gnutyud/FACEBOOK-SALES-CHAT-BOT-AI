import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

/** Project root (works regardless of cwd, e.g. under launchd). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const Env = z.object({
  META_PAGE_ID: z.string().min(1, "Page ID is required"),
  META_PAGE_TOKEN: z.string().min(1, "Page access token is required"),
  META_APP_ID: z.string().min(1, "App ID is required"),
  META_APP_SECRET: z.string().min(1, "App secret is required"),
  META_VERIFY_TOKEN: z.string().min(6, "Verify token must be at least 6 characters"),

  ANTHROPIC_API_KEY: z.string().min(1, "Claude API key is required"),
  BOT_MODEL: z.string().default("claude-opus-5-5"),
  BOT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  // Test-only overrides. Never needed in normal operation.
  BOT_ANTHROPIC_BASE_URL: z.string().url().optional(),
  BOT_DATA_DIR: z.string().optional(),

  PORT: z.coerce.number().int().positive().default(3000),
  WEBHOOK_PUBLIC_URL: z.string().url().optional(),
  NOTIFY_URL: z.string().url().optional(),
  GRAPH_API_VERSION: z.string().default("v23.0"),

  OWNER_PSID: z.string().optional(),
  OWNER_SETUP_CODE: z.string().min(8, "Choose a random setup code (min 8 chars)"),
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

const parsed = Env.safeParse(process.env);

if (!parsed.success) {
  console.error("\n❌ Missing or invalid configuration in .env:\n");
  for (const issue of parsed.error.issues) {
    console.error(`   • ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error(
    "\n👉 Copy .env.example to .env and fill in the values. See README.md, Part A.\n"
  );
  process.exit(1);
}

export const config = parsed.data;

// BOT_DATA_DIR lets the offline test suites use a throwaway directory instead
// of the real data/ folder.
export const DATA_DIR = config.BOT_DATA_DIR
  ? path.resolve(ROOT, config.BOT_DATA_DIR)
  : path.join(ROOT, "data");

export const paths = {
  db: path.join(DATA_DIR, "bot.db"),
  ordersCsv: path.join(DATA_DIR, "orders.csv"),
  knowledge: path.join(ROOT, "knowledge.md"),
  rules: path.join(ROOT, "rules.json"),
};

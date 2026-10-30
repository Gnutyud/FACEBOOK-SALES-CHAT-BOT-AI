import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

/** Project root (works regardless of cwd, e.g. under launchd). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

/** Treat an empty .env value (e.g. `NOTIFY_URL=`) as “not set”. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    schema.optional()
  );

const Env = z
  .object({
    META_PAGE_ID: z.string().min(1, "Page ID is required"),
    META_PAGE_TOKEN: z.string().min(1, "Page access token is required"),
    META_APP_ID: z.string().min(1, "App ID is required"),
    META_APP_SECRET: z.string().min(1, "App secret is required"),
    META_VERIFY_TOKEN: z.string().min(6, "Verify token must be at least 6 characters"),

    // Brain provider: Claude (Anthropic) or DeepSeek's Anthropic-compatible API.
    BOT_PROVIDER: z.enum(["anthropic", "deepseek"]).default("anthropic"),
    ANTHROPIC_API_KEY: optional(z.string().min(1)),
    DEEPSEEK_API_KEY: optional(z.string().min(1)),
    // Defaults per provider: claude-opus-5-5 / deepseek-v4-pro.
    BOT_MODEL: optional(z.string()),
    BOT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
    // Optional endpoint override (offline tests, self-hosted gateways).
    BOT_ANTHROPIC_BASE_URL: optional(z.string().url()),
    BOT_DATA_DIR: optional(z.string()),

    PORT: z.coerce.number().int().positive().default(3000),
    WEBHOOK_PUBLIC_URL: optional(z.string().url()),
    NOTIFY_URL: optional(z.string().url()),
    GRAPH_API_VERSION: z.string().default("v23.0"),

    OWNER_PSID: optional(z.string()),
    OWNER_SETUP_CODE: z.string().min(8, "Choose a random setup code (min 8 chars)"),
    DRY_RUN: z
      .string()
      .optional()
      .transform((v) => v === "1" || v === "true"),
  })
  .superRefine((env, ctx) => {
    if (env.BOT_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "Claude API key is required (or set BOT_PROVIDER=deepseek)",
      });
    }
    if (env.BOT_PROVIDER === "deepseek" && !env.DEEPSEEK_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["DEEPSEEK_API_KEY"],
        message: "DeepSeek API key is required when BOT_PROVIDER=deepseek",
      });
    }
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

const data = parsed.data;

export const config = {
  ...data,
  BOT_MODEL:
    data.BOT_MODEL ??
    (data.BOT_PROVIDER === "deepseek" ? "deepseek-v4-pro" : "claude-opus-5-5"),
};

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
  images: path.join(ROOT, "assets", "images"),
};

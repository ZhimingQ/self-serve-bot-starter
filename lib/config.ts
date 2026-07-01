/**
 * Central branding + wiring config for this reseller deployment.
 * Everything is read from env vars with sane defaults, so a reseller can
 * rebrand the entire app by editing `.env` (or Vercel project env vars) —
 * no code changes required.
 */

export type BotFramework = "openclaw" | "hermes";

export interface BrandConfig {
  name: string;
  accent: string;
  framework: BotFramework;
  apiBase: string;
}

function isBotFramework(value: string): value is BotFramework {
  return value === "openclaw" || value === "hermes";
}

const rawFramework = process.env.BOT_FRAMEWORK ?? "openclaw";

export const brand: BrandConfig = {
  name: process.env.BRAND_NAME || "YourBrand",
  accent: process.env.BRAND_ACCENT || "#4f46e5",
  framework: isBotFramework(rawFramework) ? rawFramework : "openclaw",
  apiBase: process.env.BUILD_RESELL_API_BASE || "https://openclawlaunch.com/api/v1",
};

// Server-only. Never import this from a client component / never expose to the browser.
export const buildResellApiKey = process.env.BUILD_RESELL_API_KEY || "";

export const sessionSecret = process.env.SESSION_SECRET || "";

export const upstash = {
  url: process.env.UPSTASH_REDIS_REST_URL || "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
};

// A writable directory for the JSON-file store backend (lib/store.ts). Set this
// when you deploy on a host with a persistent disk but no Upstash — e.g. the
// "Deploy via your bot" path, where the bot container bind-mounts this dir so
// signups survive restarts. Leave empty on Vercel/serverless (use Upstash there).
export const storeDir = process.env.STORE_DIR || "";

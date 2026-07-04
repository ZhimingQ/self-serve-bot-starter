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

// ── Payment (YOUR Stripe account) ─────────────────────────────────────────
// Charge your end users on YOUR OWN Stripe before their bot is provisioned —
// this is where your reseller margin lives. All server-only; NEVER expose the
// secret key or webhook secret to the browser.
//
//  - secretKey   : your Stripe secret key (sk_live_… in prod, sk_test_… to test).
//  - priceId     : the Stripe Price your customers buy (price_…). You set the
//                  amount + currency in your Stripe dashboard, so your markup
//                  over the ~$6/deploy you pay OpenClaw Launch is yours to keep.
//  - mode        : "subscription" for a recurring price, "payment" for one-time.
//                  Must match the Price's type.
//  - webhookSecret: from `stripe listen` / your dashboard webhook (whsec_…) —
//                  used to verify the /api/stripe/webhook signature.
//
// If secretKey + priceId are unset the app runs in NO-PAYMENT mode: signup
// provisions a bot immediately (the original starter behavior), so you can demo
// before wiring Stripe. Set both to gate provisioning behind a real payment.
export const stripe = {
  secretKey: process.env.STRIPE_SECRET_KEY || "",
  priceId: process.env.STRIPE_PRICE_ID || "",
  mode: (process.env.STRIPE_MODE === "payment" ? "payment" : "subscription") as
    | "subscription"
    | "payment",
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
};

/** True when Stripe is configured — provisioning is then gated behind payment. */
export const paymentsEnabled = Boolean(stripe.secretKey && stripe.priceId);

// Public base URL of THIS storefront (e.g. https://bots.youragency.com), used to
// build Stripe Checkout success/cancel redirect URLs. Falls back to localhost.
export const appUrl = process.env.APP_URL || "http://localhost:3000";

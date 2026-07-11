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

// ── Live demo mode ─────────────────────────────────────────────────────────
// When DEMO_MODE=1 this storefront is a PUBLIC, read-only showcase — safe to link
// from a marketing page. Signup and bot provisioning are HARD-DISABLED server-side
// (app/api/auth/signup + app/api/provision return 403; app/app redirects out), so
// an anonymous visitor can never spin up a real bot. The landing still renders in
// full, but its Get-started / Log-in CTAs point at DEMO_SIGNUP_URL instead of the
// in-app /signup flow. Leave DEMO_MODE unset for a normal, sign-uppable storefront.
export const demoMode = process.env.DEMO_MODE === "1";
export const demoSignupUrl =
  process.env.DEMO_SIGNUP_URL || "https://openclawlaunch.com/developer-api/templates";

// ── Startup validation ────────────────────────────────────────────────────
// Fail fast in production on a misconfigured deploy instead of limping along
// (unsigned sessions, no persistence, broken Stripe redirects). Called once from
// instrumentation.ts at server boot. A no-op in dev so `npm run dev` stays easy.
export function validateEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const problems: string[] = [];

  if (!buildResellApiKey) {
    problems.push("BUILD_RESELL_API_KEY is required (your sk_live_… Build & Resell key).");
  }
  if (!sessionSecret || sessionSecret.length < 16 || sessionSecret === "replace_with_a_long_random_string") {
    problems.push(
      "SESSION_SECRET must be a long random string — generate with " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))".`
    );
  }
  const hasUpstash = Boolean(upstash.url && upstash.token);
  if (Boolean(upstash.url) !== Boolean(upstash.token)) {
    // Only one half set — getStore() would silently ignore it and fall back to
    // STORE_DIR/memory. Make the misconfig explicit rather than losing data quietly.
    problems.push(
      "Partial Upstash config — set BOTH UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or neither)."
    );
  }
  if (!hasUpstash && !storeDir) {
    problems.push(
      "No persistent store configured — set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN " +
        "(or STORE_DIR on a persistent disk). The in-memory store loses every user on restart."
    );
  }
  if (paymentsEnabled) {
    if (!process.env.APP_URL) {
      problems.push("APP_URL must be set to this storefront's public URL, or Stripe Checkout redirects go to localhost.");
    }
    if (stripe.mode === "subscription" && !stripe.webhookSecret) {
      problems.push(
        "STRIPE_WEBHOOK_SECRET is required in subscription mode — renewals and cancellations " +
          "arrive only via the webhook, so without it a lapsed sub is never revoked."
      );
    }
  }

  if (problems.length) {
    throw new Error(
      "[config] Invalid production configuration:\n  - " + problems.join("\n  - ")
    );
  }
}

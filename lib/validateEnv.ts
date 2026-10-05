/**
 * Startup validation — fail fast in production on a misconfigured deploy
 * instead of limping along with unsigned sessions, no persistence, or broken
 * Stripe redirects. Called once from instrumentation.ts at server boot, and a
 * no-op in development so `npm run dev` stays easy.
 *
 * WHY THIS IS NOT IN lib/config.ts
 *
 * Next compiles instrumentation.ts for BOTH the Node and Edge runtimes, even in
 * an app like this one with no middleware and no edge routes. lib/config reads
 * an optional branding file with `node:fs`, and the Edge pass cannot resolve
 * that scheme — so importing config from instrumentation failed the compile and
 * returned 500 for every page under `npm run dev`, while `next build` still
 * succeeded. The README's own first step was the one that broke.
 *
 * Keeping this module free of `node:fs` in its import graph fixes that without
 * bundler configuration, which matters for a template a reseller may build on
 * Vercel, locally, or inside their bot's container.
 *
 * It therefore reads process.env directly rather than importing config's
 * derived constants. Those constants are plain `process.env.X || ""` reads, and
 * a startup validator wants the raw environment anyway.
 */
import { validateLocaleConfig } from "./localeConfig";
import { botToolsProblems } from "./botTools";

export function validateEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const problems: string[] = [];
  problems.push(...validateLocaleConfig(process.env));

  const buildResellApiKey = process.env.BUILD_RESELL_API_KEY || "";
  const sessionSecret = process.env.SESSION_SECRET || "";
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL || "";
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const storeDir = process.env.STORE_DIR || "";
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
  const stripePriceId = process.env.STRIPE_PRICE_ID || "";
  const stripeMode = process.env.STRIPE_MODE === "payment" ? "payment" : "subscription";
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
  const paymentsEnabled = Boolean(stripeSecretKey && stripePriceId);

  if (!buildResellApiKey) {
    problems.push("BUILD_RESELL_API_KEY is required (your sk_live_… Build & Resell key).");
  }
  if (!sessionSecret || sessionSecret.length < 16 || sessionSecret === "replace_with_a_long_random_string") {
    problems.push(
      "SESSION_SECRET must be a long random string — generate with " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))".`
    );
  }
  const hasUpstash = Boolean(upstashUrl && upstashToken);
  if (Boolean(upstashUrl) !== Boolean(upstashToken)) {
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
    if (stripeMode === "subscription" && !stripeWebhookSecret) {
      problems.push(
        "STRIPE_WEBHOOK_SECRET is required in subscription mode — renewals and cancellations " +
          "arrive only via the webhook, so without it a lapsed sub is never revoked."
      );
    }
  }

  // CHANNELS is an allowlist, and a misspelt allowlist is the dangerous kind of
  // typo: it is enforced server-side, so getting it wrong decides what customers
  // may connect. config.ts resolves an unrecognisable list to NOTHING rather than
  // to everything; this turns that quiet empty panel into a boot failure that
  // names the offending value.
  const rawChannels = process.env.CHANNELS?.trim();
  if (rawChannels) {
    const known = ["wechat", "telegram", "whatsapp", "discord", "feishu", "slack"];
    const named = rawChannels.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = named.filter((s) => !known.includes(s));
    if (named.length === 0 || unknown.length === named.length) {
      problems.push(
        `CHANNELS names no known channel (${rawChannels}). Valid values: ${known.join(", ")}. ` +
          "Leave it unset to offer every channel the bot supports."
      );
    } else if (unknown.length) {
      problems.push(
        `CHANNELS contains unknown channel(s): ${unknown.join(", ")}. Valid values: ${known.join(", ")}.`
      );
    }
  }

  // BOT_TOOLS is an allowlist enforced server-side, so a typo decides what
  // customers can do. Unknown names fail the boot rather than being dropped.
  problems.push(...botToolsProblems(process.env.BOT_TOOLS));

  if (problems.length) {
    throw new Error(
      "[config] Invalid production configuration:\n  - " + problems.join("\n  - ")
    );
  }
}

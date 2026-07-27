/**
 * Central branding + wiring config for this reseller deployment.
 * Everything is read from env vars with sane defaults, so a reseller can
 * rebrand the entire app by editing `.env` (or Vercel project env vars) —
 * no code changes required.
 */

export type BotFramework = "openclaw" | "hermes";

import { readFileSync } from "node:fs";

export interface BrandConfig {
  revision: number;
  name: string;
  websiteUrl: string;
  accent: string;
  readableAccent: string;
  onAccent: "#000000" | "#ffffff";
  logoUrl: string;
  priceLabel: string;
  priceNote: string;
  supportEmail: string;
  privacyUrl: string;
  termsUrl: string;
  framework: BotFramework;
  apiBase: string;
}

interface BrandingFile {
  revision?: unknown;
  brandName?: unknown;
  businessWebsiteUrl?: unknown;
  logoUrl?: unknown;
  accent?: unknown;
  supportEmail?: unknown;
  privacyUrl?: unknown;
  termsUrl?: unknown;
  priceLabel?: unknown;
  priceNote?: unknown;
}

function readBrandingFile(): BrandingFile {
  const filename = process.env.STOREFRONT_BRANDING_FILE?.trim();
  if (!filename) return {};
  try {
    const raw = readFileSync(filename, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as BrandingFile : {};
  } catch {
    // Self-hosted and legacy installs continue to use the env fallback below.
    return {};
  }
}

function fileString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function accentColors(hex: string): { readableAccent: string; onAccent: "#000000" | "#ffffff" } {
  const valid = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#777e69";
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(valid.slice(offset, offset + 2), 16));
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (values: number[]) => 0.2126 * channel(values[0]) + 0.7152 * channel(values[1]) + 0.0722 * channel(values[2]);
  const originalLuminance = luminance(rgb);
  const onAccent = originalLuminance > 0.36 ? "#000000" : "#ffffff";

  // Preserve the chosen spot color, but derive a dark readable variant for
  // text/focus use on the template's light surfaces.
  let readable = rgb;
  while ((1.05 / (luminance(readable) + 0.05)) < 4.5) {
    readable = readable.map((value) => Math.max(0, Math.round(value * 0.86)));
  }
  return {
    readableAccent: `#${readable.map((value) => value.toString(16).padStart(2, "0")).join("")}`,
    onAccent,
  };
}

function isBotFramework(value: string): value is BotFramework {
  return value === "openclaw" || value === "hermes";
}

const rawFramework = process.env.BOT_FRAMEWORK ?? "openclaw";
const brandingFile = readBrandingFile();
const configuredBrandName = fileString(brandingFile.brandName) || process.env.BRAND_NAME?.trim() || "YourBrand";
const configuredAccent = fileString(brandingFile.accent) || process.env.BRAND_ACCENT || "#777e69";
const derivedAccent = accentColors(configuredAccent);

// Keep infrastructure/business-model language out of the customer-facing brand.
// Existing demo environments may still have a legacy "... Reseller" BRAND_NAME;
// normalize it here so metadata and every rendered surface stay customer-friendly.
const publicBrandName =
  configuredBrandName.replace(/\breseller\b/gi, "").replace(/\s{2,}/g, " ").trim() ||
  "YourBrand";

export const brand: BrandConfig = {
  revision: typeof brandingFile.revision === "number" && Number.isSafeInteger(brandingFile.revision)
    ? brandingFile.revision
    : 0,
  name: publicBrandName,
  websiteUrl: fileString(brandingFile.businessWebsiteUrl) || process.env.BUSINESS_WEBSITE_URL?.trim() || "",
  accent: configuredAccent,
  readableAccent: derivedAccent.readableAccent,
  onAccent: derivedAccent.onAccent,
  logoUrl: fileString(brandingFile.logoUrl) || process.env.BRAND_LOGO_URL?.trim() || "",
  priceLabel: fileString(brandingFile.priceLabel) || process.env.PUBLIC_PRICE_LABEL?.trim() || "",
  priceNote: fileString(brandingFile.priceNote) || process.env.PUBLIC_PRICE_NOTE?.trim() || "",
  supportEmail: fileString(brandingFile.supportEmail) || process.env.SUPPORT_EMAIL?.trim() || "",
  privacyUrl: fileString(brandingFile.privacyUrl) || process.env.PRIVACY_URL?.trim() || "",
  termsUrl: fileString(brandingFile.termsUrl) || process.env.TERMS_URL?.trim() || "",
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

// Forwarded IP headers are trustworthy only when a known edge proxy overwrites
// them. Vercel does this automatically; managed installs set the explicit flag.
// Direct/self-hosted Node deployments default to false until their proxy is
// configured to replace (not append user-supplied) X-Real-IP/X-Forwarded-For.
export const trustProxyHeaders = process.env.VERCEL === "1" || process.env.TRUST_PROXY_HEADERS === "1";

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
// (app/api/auth/signup + new-instance provisioning return 403), so an anonymous
// visitor can never spin up a real bot. Existing users can still log in and use
// an already-provisioned assistant. The landing's signup CTAs point at
// DEMO_SIGNUP_URL; login stays in-app. Leave DEMO_MODE unset for a normal storefront.
export const demoMode = process.env.DEMO_MODE === "1";
export const demoSignupUrl =
  process.env.DEMO_SIGNUP_URL || "https://openclawlaunch.com/developer-api/templates";

// ── Startup validation ────────────────────────────────────────────────────
// Lives in ./validateEnv so that instrumentation.ts can import it WITHOUT
// pulling this module's node:fs branding-file read into the Edge compile — see
// the note at the top of that file. Re-exported here so the old import path
// keeps working.
export { validateEnv } from "./validateEnv";

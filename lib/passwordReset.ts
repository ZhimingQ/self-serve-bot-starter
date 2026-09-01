import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore, type StoredUser } from "./store";
import { brand, appUrl, resetEmail } from "./config";

/**
 * Password reset — "I forgot my password" for a storefront's own customers.
 *
 * THE SHAPE, and why it is this shape:
 *
 * The token is random, single-use, and short-lived, and only its SHA-256 hash is
 * ever stored. A dump of the store therefore cannot be replayed into an account
 * takeover — the only copy of the real token is in the customer's inbox.
 *
 * Delivery is over an HTTP email API (Resend) with `fetch`, deliberately NOT an
 * SMTP library. This template is copied into a reseller's own repo and rebuilt
 * in a memory-capped container; adding a dependency costs every one of them an
 * install, and a mail library is a large one. A key in `RESEND_API_KEY` is the
 * whole setup.
 *
 * When no key is configured, this module REFUSES to mint a token rather than
 * minting one nobody can deliver. A reset that silently goes nowhere is worse
 * than an honest "contact support" — the customer waits for an email that was
 * never sent. The storefront owner still has `npm run reset-password` for that
 * case, which needs no configuration at all.
 */

/** One hour. Long enough to survive a slow inbox, short enough that a token
 *  found later in a forwarded email or a shared screen is already dead. */
export const RESET_TTL_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * True when this storefront can actually deliver a WORKING reset email.
 *
 * APP_URL is part of that, not a separate concern: it is what the emailed link
 * points at, and it defaults to `http://localhost:3000`. A storefront with a
 * Resend key but no APP_URL would send real email containing a link that only
 * resolves on the server itself — a dead end that looks like a delivered reset,
 * which is strictly worse than the honest "contact support" this returns false
 * for. Storefronts deployed through "Deploy via your bot" are exactly this case:
 * their generated .env has no APP_URL.
 */
export function resetEmailConfigured(): boolean {
  return Boolean(resetEmail.apiKey && resetEmail.from && isPublicAppUrl(appUrl));
}

/** Exported for tests: this predicate decides whether emailed links are sent at
 *  all, so it is worth pinning case by case rather than only through the two
 *  environments the other test files happen to construct. */
export function isPublicAppUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  // A link the customer's mail client cannot reach: loopback, or a bare
  // single-label host that only resolves inside the deployment's own network.
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) return false;
  if (host === "127.0.0.1" || host.startsWith("127.")) return false;
  if (!host.includes(".")) return false;
  return true;
}

export interface ResetRequestOutcome {
  /** Whether an email was dispatched. Callers must NOT surface this to the
   *  browser per-address — see the anti-enumeration note in the route. */
  sent: boolean;
  reason?: "no_user" | "not_configured" | "send_failed";
}

/**
 * Mint a reset token for `email` and send it. Returns quietly for an unknown
 * address: the caller answers identically either way so the endpoint cannot be
 * used to test which customers exist.
 */
export async function requestPasswordReset(email: string): Promise<ResetRequestOutcome> {
  if (!resetEmailConfigured()) return { sent: false, reason: "not_configured" };

  const store = getStore();
  const user = await store.getUserByEmail(email);
  if (!user) return { sent: false, reason: "no_user" };

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  await store.setUserAuth(user.id, {
    resetTokenHash: tokenHash,
    resetTokenExpiresAt: Date.now() + RESET_TTL_MS,
  });

  const sent = await sendResetEmail(user.email, token);
  if (!sent) {
    // Do not leave a live token behind for an email that never went out — but
    // retire only OUR token. Sending is a network round trip, so a second request
    // can mint and deliver a replacement while this one is still waiting on the
    // provider; an unconditional clear would then kill a link that IS in the
    // customer's inbox, and they would be locked out by our own cleanup.
    const current = await store.getUserById(user.id);
    if (current?.resetTokenHash === tokenHash) {
      await store.setUserAuth(user.id, { resetTokenHash: undefined, resetTokenExpiresAt: undefined });
    }
    return { sent: false, reason: "send_failed" };
  }
  return { sent: true };
}

/**
 * Resolve a token to its user, or null when it is unknown, expired, or spent.
 *
 * The equality check below is LOAD-BEARING, not defensive padding. Two overlapping
 * mint requests can leave an index entry for the superseded hash — neither sees a
 * prior token, so neither retires the other — and that orphan still resolves to a
 * real user. Requiring the record to carry the presented hash is what makes the
 * orphan inert: only the token the record itself names is accepted. Doing it with
 * timingSafeEqual keeps the comparison constant-time as a bonus.
 */
export async function findUserForResetToken(token: string): Promise<StoredUser | null> {
  if (!token || token.length < 32 || token.length > 128) return null;
  const store = getStore();
  const tokenHash = hashToken(token);
  const user = await store.getUserByResetTokenHash(tokenHash);
  if (!user?.resetTokenHash) return null;

  const a = Buffer.from(user.resetTokenHash, "hex");
  const b = Buffer.from(tokenHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (!user.resetTokenExpiresAt || user.resetTokenExpiresAt < Date.now()) return null;
  return user;
}

/**
 * Spend the token and set the new password.
 *
 * Two ordering decisions, both deliberate:
 *
 * 1. The session version is rotated FIRST. These are two separate writes and
 *    there is no transaction across them, so one of them can be the last thing
 *    that happens — a crash, a dropped Upstash request, a container restart. Of
 *    the two possible half-states, "signed out everywhere but the password did
 *    not change" is harmless (the customer signs back in, or resets again with
 *    the still-live token), while "password changed but every old session still
 *    works" silently defeats the reset for the person it was meant to evict.
 *    Rotating first makes the survivable half-state the one that can happen.
 *
 * 2. The token is cleared in the SAME write that sets the password, and that
 *    write is CONDITIONAL on the record still holding this exact token. Finding
 *    the token and spending it are two steps with a gap between them; without
 *    the condition, two redemptions of one link could both pass step one and
 *    both set a password, and a redemption that started before the customer
 *    requested a fresh link could clear the newer token instead of its own.
 *    Failing the condition means the link was already spent or superseded, which
 *    is precisely what `false` reports.
 */
export async function completePasswordReset(
  token: string,
  passwordHash: string,
  passwordSalt: string,
): Promise<boolean> {
  const user = await findUserForResetToken(token);
  if (!user) return false;

  const store = getStore();
  await store.rotateUserSessionVersion(user.id);
  return store.setUserAuth(
    user.id,
    {
      passwordHash,
      passwordSalt,
      resetTokenHash: undefined,
      resetTokenExpiresAt: undefined,
    },
    hashToken(token),
  );
}

/** Send via the Resend HTTP API. Returns false on any failure; the caller
 *  retires the token rather than pretending an email is in flight. */
async function sendResetEmail(to: string, token: string): Promise<boolean> {
  // The token goes in the FRAGMENT, not the query string. A query string is sent
  // to the server on every request, so it is written to the access log of Caddy,
  // Vercel, or whatever log shipper the reseller runs — and this particular query
  // string is a working account-takeover credential with an hour of life left,
  // parked in a file that is routinely shipped to third parties and included in
  // backups. Fragments are never transmitted; the browser keeps them and the page
  // reads its own. The page still accepts `?token=` so a hand-edited or mangled
  // link is not a dead end, but nothing we send uses that form.
  const link = `${appUrl.replace(/\/$/, "")}/reset-password#token=${encodeURIComponent(token)}`;
  const subject = `Reset your ${brand.name} password`;
  const text = [
    `Someone asked to reset the password for your ${brand.name} account.`,
    "",
    `Open this link to choose a new one (it expires in an hour):`,
    link,
    "",
    "If that wasn't you, ignore this email — your password has not changed.",
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resetEmail.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: resetEmail.from, to: [to], subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Body may name a misconfigured sending domain — useful to the RESELLER in
      // their own logs, and it never reaches the customer.
      console.error(`[passwordReset] send failed (${res.status}):`, (await res.text().catch(() => "")).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error("[passwordReset] send threw:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Small, dependency-free rate limiter for the storefront's public routes.
 *
 * Two backends, chosen automatically:
 *  1. Upstash Redis (fixed-window INCR + EXPIRE) when it's configured — this is
 *     the one that actually works on serverless / multi-instance hosts, because
 *     the counter is shared across every process.
 *  2. An in-memory fixed-window map for local dev / single-process hosts.
 *
 * It exists because a reseller's storefront is public: without it, one script can
 * brute-force logins, spam signups, or (the expensive one) hammer /api/provision
 * and /api/chat to run up bot-creation + LLM cost on the RESELLER's account.
 *
 * Fixed-window (not sliding) is intentionally simple — it's more than enough to
 * stop abuse for a starter, and has no extra moving parts to get wrong.
 */

import { createHash } from "node:crypto";
import { trustProxyHeaders, upstash } from "./config";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets — surfaced as the Retry-After header. */
  retryAfterSec: number;
}

// In-memory buckets: `ratelimit:<bucket>:<id>` → { count, resetAt(ms) }.
const memBuckets = new Map<string, { count: number; resetAt: number }>();

async function upstashCommand<T = unknown>(cmd: (string | number)[]): Promise<T> {
  const res = await fetch(upstash.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${upstash.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ratelimit upstash command failed (${res.status})`);
  const data = (await res.json()) as { result: T };
  return data.result;
}

/**
 * Count one hit against `<bucket>:<id>` and report whether it's within `limit`
 * hits per `windowSec`. On the Upstash backend a transient Redis error fails
 * OPEN (allows the request) — a rate limiter should degrade to "no limit", never
 * to "lock everyone out", if its datastore blips.
 */
export async function rateLimit(
  bucket: string,
  id: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  const key = `ratelimit:${bucket}:${id}`;

  if (upstash.url && upstash.token) {
    try {
      // First hit: create the counter at 1 WITH its TTL in a single atomic op.
      // Doing INCR then a separate EXPIRE risks a crash in between that leaves a
      // key with no TTL — it would never reset and could block the limiter
      // forever. SET ... EX ... NX can't leave that orphan state.
      const created = await upstashCommand<string | null>([
        "SET", key, "1", "EX", windowSec, "NX",
      ]);
      // "OK" → we created it (count 1). null → it already exists (and, having
      // been born via SET…EX, already has a TTL), so just count this hit.
      const count = created === "OK" ? 1 : await upstashCommand<number>(["INCR", key]);
      const ok = count <= limit;
      return { ok, remaining: Math.max(0, limit - count), retryAfterSec: ok ? 0 : windowSec };
    } catch (err) {
      console.error("[ratelimit] upstash error — allowing request (fail-open):", err);
      return { ok: true, remaining: limit, retryAfterSec: 0 };
    }
  }

  // In-memory fixed window (single process).
  const now = Date.now();
  const existing = memBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    // Opportunistically evict expired buckets so the map can't grow unbounded.
    if (memBuckets.size > 10_000) {
      for (const [k, v] of memBuckets) if (v.resetAt <= now) memBuckets.delete(k);
    }
    memBuckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { ok: true, remaining: limit - 1, retryAfterSec: 0 };
  }
  existing.count += 1;
  const ok = existing.count <= limit;
  return {
    ok,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSec: ok ? 0 : Math.ceil((existing.resetAt - now) / 1000),
  };
}

/**
 * Best-effort client IP from the trusted edge proxy.
 *
 * OpenClaw Launch's Caddy snippets overwrite X-Real-IP with `{remote_host}`.
 * Prefer that value so a client-supplied X-Forwarded-For prefix cannot rotate
 * rate-limit identities. The right-most XFF hop is the safest fallback for
 * proxies that append their observed client address.
 */
export function clientIp(request: Request, trustForwardedHeaders = trustProxyHeaders): string {
  if (!trustForwardedHeaders) return "unknown";
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 128);
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return (xff.split(",").at(-1)?.trim() || "unknown").slice(0, 128);
  return "unknown";
}

/** Hash user identifiers before using them in shared rate-limit keys. */
export function rateLimitIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

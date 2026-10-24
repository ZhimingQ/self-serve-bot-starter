import "server-only";
import { createHash } from "node:crypto";
import { brand, buildResellApiKey, trustProxyHeaders } from "./config";
import { clientIp } from "./rateLimit";

/**
 * Same-path pass-through to the platform, so a customer never sees the
 * platform's address.
 *
 * The platform hands this storefront's customers links on THIS domain with the
 * platform's own paths — files the assistant sends (/d/<id>), the assistant's
 * OpenAI-compatible endpoint (/api/instances/<id>/endpoint/…) and the "My
 * Computer" connect scripts (/connect.sh, /connect.ps1) — and this storefront
 * forwards each request to the platform unchanged. It only does so after
 * /api/health reports `linkProxy: LINK_PROXY_VERSION` and a fingerprint of
 * this storefront's reseller key, so a build without these routes (or a site
 * that is not this storefront) keeps getting platform links.
 *
 * Each request is authorized on its own (a /d id is a 30-minute capability,
 * the endpoint uses the customer's own bearer key) and the visitor's cookies are
 * never forwarded. The reseller key goes along only to name the visitor
 * (visitorHeaders): every customer reaches the platform from this one server,
 * and without it they would all share one per-address rate limit there.
 */
export const LINK_PROXY_VERSION = 1;

/**
 * Proof for /api/health that this storefront runs with the reseller key the
 * platform expects for this domain. The platform stores only sha256(key), so
 * it can recompute this; being a hash of that hash it reveals nothing usable.
 * Empty when no key is configured, or when this server cannot tell its
 * visitors apart (TRUST_PROXY_HEADERS / VERCEL unset): every customer would
 * then share one rate limit here and at the platform, so the platform keeps
 * its own links instead.
 */
export function linkProxyKeyFingerprint(): string {
  if (!buildResellApiKey || !trustProxyHeaders) return "";
  const keyHash = createHash("sha256").update(buildResellApiKey).digest("hex");
  return createHash("sha256").update(`ocl-link-proxy:${keyHash}`).digest("hex").slice(0, 32);
}

/** Tells the platform which visitor this is, authenticated by the reseller key. */
export function visitorHeaders(request: Request): Record<string, string> {
  const ip = clientIp(request);
  if (!buildResellApiKey || !ip || ip === "unknown") return {};
  return { "x-ocl-proxy-key": buildResellApiKey, "x-ocl-client-ip": ip };
}

/** Origin of the platform this storefront sells (from BUILD_RESELL_API_BASE). */
export function platformOrigin(): string {
  try {
    return new URL(brand.apiBase).origin;
  } catch {
    return "https://openclawlaunch.com";
  }
}

/** Request headers worth passing upstream; everything else (cookies included) stays here. */
const FORWARD_REQUEST = [
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "origin",
  "range",
  "user-agent",
  "access-control-request-method",
  "access-control-request-headers",
  "x-request-id",
  "openai-organization",
  "openai-project",
] as const;

/** Upstream response headers that are hop-by-hop, ours to set, or must not reach this domain. */
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "set-cookie",
  "alt-svc",
  "server",
  "via",
  "cf-ray",
  "cf-cache-status",
  "nel",
  "report-to",
  "strict-transport-security",
]);

export function forwardRequestHeaders(request: Request, overrides: Record<string, string> = {}): Headers {
  const out = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  // Ask for the bytes as stored. fetch() would otherwise transparently decode a
  // compressed body while the content-length still described the encoded one.
  out.set("accept-encoding", "identity");
  for (const [k, v] of Object.entries(overrides)) out.set(k, v);
  return out;
}

export function forwardResponseHeaders(upstream: Response): Headers {
  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name.toLowerCase())) out.append(name, value);
  });
  // If anything was decoded on the way in, the upstream length and encoding no
  // longer describe the body we send.
  if (out.has("content-encoding")) {
    out.delete("content-encoding");
    out.delete("content-length");
  }
  return out;
}

/** fetch() to the platform. Never follows redirects: a redirect would leak the platform host. */
export async function platformFetch(path: string, init: RequestInit & { duplex?: "half" }): Promise<Response | null> {
  try {
    return await fetch(`${platformOrigin()}${path}`, { ...init, redirect: "manual", cache: "no-store" });
  } catch {
    return null;
  }
}

/** What /api/health says about the pass-through: nothing when it is not usable here. */
export function linkProxyFields(): { linkProxy?: number; linkProxyKey?: string } {
  const linkProxyKey = linkProxyKeyFingerprint();
  return linkProxyKey ? { linkProxy: LINK_PROXY_VERSION, linkProxyKey } : {};
}

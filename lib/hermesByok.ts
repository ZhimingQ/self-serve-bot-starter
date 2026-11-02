/**
 * Server-side checks behind the Hermes "use your own API key" panel.
 *
 * The platform writes whatever endpoint it is given and restarts the bot; it
 * does not test it. A typo there leaves a paying customer's assistant running
 * and silent, so everything is proven here first: one tiny chat request with
 * the customer's key, model and URL, which must come back as a real chat
 * completion. It is billed to the customer's own provider account and costs a
 * fraction of a cent.
 *
 * A custom endpoint is a URL the customer typed, fetched from this server. It
 * must be https on 443 with a public hostname, and every connection is pinned
 * to addresses checked at connect time (the `lookup` hook below), so a DNS
 * answer that changes after validation cannot steer a request inward. Requests
 * never follow redirects, bodies are capped, and the only text ever passed back
 * is the provider's own short error message with the customer's key scrubbed
 * out of it.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { MODEL_ID_RE, hermesProvider } from "./hermesProviders";

const TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 1_000_000;
const BLOCKED_HOSTS = ["api.x.ai", "inference-api.nousresearch.com"];

// One list per family. A single BlockList also matches IPv4 addresses against
// IPv4-mapped IPv6 rules, so "::ffff:0:0/96" in a shared list rejected every
// public IPv4 address and no provider could ever be reached.
const NON_PUBLIC_V4 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["192.88.99.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) NON_PUBLIC_V4.addSubnet(net, bits, "ipv4");
const NON_PUBLIC_V6 = new BlockList();
for (const [net, bits] of [
  // Only global unicast (GLOBAL_V6) is dialled at all; these are the special
  // ranges inside it. 6to4 and Teredo (inside 2001::/23) can embed an IPv4.
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) NON_PUBLIC_V6.addSubnet(net, bits, "ipv6");
// Everything outside 2000::/3 (loopback, mapped, NAT64, link/site-local, ULA,
// multicast, SRv6, discard) is refused by not being in here.
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, "ipv4");
  if (family === 6) return GLOBAL_V6.check(address, "ipv6") && !NON_PUBLIC_V6.check(address, "ipv6");
  return false;
}

/** Resolves like dns.lookup, but fails the connection if ANY address the name
 *  resolves to is not public. Runs on every connect, so it is the address
 *  actually dialled that is checked, not an earlier answer. */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as unknown as { address: string; family: number }[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      return callback(Object.assign(new Error("non-public address"), { code: "ENONPUBLIC" }), "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

export type ResolvedEndpoint = { provider: string; baseUrl: string };

/** OpenCode refuses any chat request without a session id (400 MissingSessionID),
 *  so a good key would fail the save probe. Decided by host, not provider id:
 *  "Other endpoint" can point at opencode.ai too. Hermes sends its own once the
 *  bot is running, so this one only has to be unique. */
export function endpointHeaders(url: string): Record<string, string> {
  return new URL(url).hostname === "opencode.ai" ? { "x-opencode-session": `storefront-${randomUUID()}` } : {};
}

/** Nous Portal refuses a chat with no `user=` tag (400 missing tags), so a good key
 *  would fail the save probe. The platform writes the same tag into the bot. */
export function endpointBody(url: string): Record<string, unknown> {
  return new URL(url).hostname === "inference-api.nousresearch.com" ? { tags: ["user=hermes"] } : {};
}

/** Provider id (+ base URL for "custom") to the endpoint the bot will call. */
export function resolveEndpoint(provider: string, rawBaseUrl: unknown): ResolvedEndpoint | { error: string } {
  const listed = hermesProvider(provider);
  if (listed) return { provider: listed.id, baseUrl: listed.baseUrl };
  if (provider !== "custom") return { error: "invalid_provider" };
  if (typeof rawBaseUrl !== "string" || rawBaseUrl.length > 300) return { error: "invalid_base_url" };
  let u: URL;
  try { u = new URL(rawBaseUrl.trim()); } catch { return { error: "invalid_base_url" }; }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || u.search || (u.port && u.port !== "443")) {
    return { error: "invalid_base_url" };
  }
  const host = u.hostname.toLowerCase();
  // A trailing dot is the same host to DNS but not to a string comparison.
  if (host.endsWith(".") || !host.includes(".") || isIP(host.replace(/^\[|\]$/g, ""))) return { error: "invalid_base_url" };
  if (BLOCKED_HOSTS.some((h) => host === h || host.endsWith("." + h))) return { error: "blocked_host" };
  return { provider: "custom", baseUrl: u.toString().replace(/\/$/, "") };
}

type Reply = { status: number; json: unknown };

function send(ep: ResolvedEndpoint, url: string, key: string, body?: unknown): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (err: Error | null, reply?: Reply) => {
      if (deadline) clearTimeout(deadline);
      if (err) reject(err); else resolve(reply as Reply);
    };
    let req: ReturnType<typeof httpsRequest>;
    try {
      req = httpsRequest(url, {
        method: payload ? "POST" : "GET",
        lookup: publicOnlyLookup,
        timeout: TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${key}`,
          ...endpointHeaders(url),
          // Anthropic's /v1/models wants its own headers. Only Anthropic gets
          // them: OpenRouter answers them with its short Anthropic-format list.
          ...(ep.provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : {}),
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) { req.destroy(new Error("body too large")); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          let json: unknown = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json = null; }
          finish(null, { status: res.statusCode ?? 0, json });
        });
        res.on("error", (e) => finish(e));
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // Absolute deadline over DNS, connect and the whole body. The socket
    // `timeout` only fires on inactivity, so a trickling endpoint could
    // otherwise hold a customer's queued switch-back for as long as it liked.
    deadline = setTimeout(() => req.destroy(new Error("deadline")), TIMEOUT_MS);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => finish(e));
    try {
      if (payload) req.write(payload);
      req.end();
    } catch (err) {
      req.destroy();
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** The provider's own error line, short, with the customer's key removed. */
function providerMessage(body: unknown, key: string): string | undefined {
  const b = body as { error?: { message?: unknown } | string; message?: unknown } | null;
  const raw = typeof b?.error === "string" ? b.error : typeof b?.error?.message === "string" ? b.error.message : typeof b?.message === "string" ? b.message : undefined;
  if (!raw) return undefined;
  return raw.split(key).join("[your key]").replace(/\s+/g, " ").slice(0, 220);
}

/** Models the key can use, best effort: an empty list just means "type it". */
export async function listModels(ep: ResolvedEndpoint, key: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string; message?: string }> {
  let r: Reply;
  try { r = await send(ep, `${ep.baseUrl}/models`, key); } catch { return { ok: false, error: "unreachable" }; }
  if (r.status === 401 || r.status === 403) return { ok: false, error: "invalid_key", message: providerMessage(r.json, key) };
  if (r.status < 200 || r.status >= 300) return { ok: true, models: [] };
  const data = (r.json as { data?: unknown } | null)?.data;
  const ids = Array.isArray(data)
    ? data.map((m) => (m && typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : "")).filter((id) => MODEL_ID_RE.test(id))
    : [];
  return { ok: true, models: [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 500) };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A chat completion as the bot will need it: choices[0].message is an object
 *  carrying a `content` field (text, null, or content parts), and no error. */
function isChatCompletion(json: unknown): boolean {
  if (!isPlainObject(json) || json.error != null) return false;
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isPlainObject(choices[0])) return false;
  const message = choices[0].message;
  if (!isPlainObject(message) || !("content" in message)) return false;
  const c = message.content;
  return typeof c === "string" || c === null || Array.isArray(c);
}

/** One tiny chat request. Proves the key, the URL and the model together. */
export async function probeChat(ep: ResolvedEndpoint, key: string, model: string): Promise<{ ok: true } | { ok: false; error: string; message?: string }> {
  const url = `${ep.baseUrl}/chat/completions`;
  const messages = [{ role: "user", content: "Reply with OK." }];
  const extra = endpointBody(url);
  let r: Reply;
  try {
    r = await send(ep, url, key, { ...extra, model, messages, max_tokens: 16 });
    // Newer OpenAI reasoning models refuse max_tokens and want this instead.
    if (r.status === 400 && /max_completion_tokens/.test(JSON.stringify(r.json ?? ""))) {
      r = await send(ep, url, key, { ...extra, model, messages, max_completion_tokens: 64 });
    }
  } catch {
    return { ok: false, error: "unreachable" };
  }
  const message = providerMessage(r.json, key);
  if (r.status >= 200 && r.status < 300) {
    // A 200 that is not a chat completion (an HTML page, an error object) is a
    // wrong endpoint, not a working one.
    return isChatCompletion(r.json) ? { ok: true } : { ok: false, error: "probe_failed", message };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, error: "invalid_key", message };
  if (r.status === 402) return { ok: false, error: "no_credit", message };
  if (r.status === 404) return { ok: false, error: "model_not_found", message };
  if (r.status === 429) return { ok: false, error: "provider_busy", message };
  return { ok: false, error: "probe_failed", message };
}

/** "sk-or-v…a1b2". Never more than 6 + 4 characters of the key. */
export function maskKey(key: string): string {
  return key.length <= 16 ? "••••" : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

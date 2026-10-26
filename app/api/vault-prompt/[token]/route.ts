import { forwardRequestHeaders, forwardResponseHeaders, platformFetch, visitorHeaders } from "../../../../lib/linkProxy";
import { clientIp, rateLimit } from "../../../../lib/rateLimit";

/**
 * GET/POST /api/vault-prompt/<token> — backend of the one-time /v/<token> page,
 * passed through to the platform unchanged. GET returns what the form shows
 * (which site, login or code); POST carries the customer's answer, which the
 * platform holds in memory only until their assistant collects it. Nothing
 * here stores or logs the body.
 */

export const dynamic = "force-dynamic";

const TOKEN_SHAPE = /^[0-9a-f]{32}$/;
const MAX_BODY = 4096;
const NO_STORE = { "Cache-Control": "no-store" };

// Never buffer more than `max` bytes of an unauthenticated body.
async function readBounded(request: Request, max: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") || "0") > max) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

async function pass(request: Request, token: string, method: "GET" | "POST"): Promise<Response> {
  if (!token || !TOKEN_SHAPE.test(token)) return Response.json({ error: "gone" }, { status: 404, headers: NO_STORE });
  // Every customer reaches the platform from this server's one address, so the
  // per-visitor limit lives here (the platform also limits per named visitor).
  const rl = await rateLimit(method === "POST" ? "vault-prompt-submit" : "vault-prompt-view", clientIp(request), method === "POST" ? 20 : 60, 600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });

  let body: string | undefined;
  if (method === "POST") {
    body = await readBounded(request, MAX_BODY);
    if (body === undefined) return Response.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  }
  const upstream = await platformFetch(`/api/vault-prompt/${token}`, {
    method,
    headers: forwardRequestHeaders(request, { accept: "application/json", ...visitorHeaders(request) }),
    body,
    signal: request.signal,
  });
  if (!upstream) return Response.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return new Response(upstream.body, { status: upstream.status, headers: forwardResponseHeaders(upstream) });
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return pass(request, token, "GET");
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return pass(request, token, "POST");
}

import { forwardRequestHeaders, forwardResponseHeaders, platformFetch, visitorHeaders } from "../../../../../../lib/linkProxy";

/**
 * /api/instances/<id>/endpoint/* — the assistant's OpenAI-compatible endpoint
 * (…/endpoint/v1/…) and its bot-to-bot peering routes (…/endpoint/api/sessions…),
 * on this storefront's own domain.
 *
 * Same path as on the platform, passed through unchanged; the platform keeps
 * the exact list of allowed routes. The customer's own bearer key authorizes
 * every call there, and no cookie is forwarded. Streaming responses (SSE) are
 * piped as they arrive. The visitor's address goes along (visitorHeaders) so
 * the platform's per-address limits apply per customer, not to this server.
 */

export const dynamic = "force-dynamic";
// A long agent turn can stream for minutes.
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT_RE = /^[A-Za-z0-9._~:@-]{1,200}$/;

type Ctx = { params: Promise<{ id: string; path: string[] }> };

async function pass(request: Request, ctx: Ctx): Promise<Response> {
  const { id, path } = await ctx.params;
  if (!UUID_RE.test(id) || !Array.isArray(path) || path.length === 0 || path.length > 8
    || path.some((s) => !SEGMENT_RE.test(s) || s === "." || s === "..")) {
    return Response.json({ error: { message: "Not found", type: "invalid_request_error" } }, { status: 404 });
  }
  const search = new URL(request.url).search;
  const target = `/api/instances/${id}/endpoint/${path.map(encodeURIComponent).join("/")}${search}`;
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;

  const upstream = await platformFetch(target, {
    method: request.method,
    headers: forwardRequestHeaders(request, visitorHeaders(request)),
    body: hasBody ? request.body : undefined,
    ...(hasBody ? { duplex: "half" as const } : {}),
    signal: request.signal,
  });
  if (!upstream) {
    return Response.json({ error: { message: "The assistant could not be reached. Try again shortly.", type: "server_error" } }, { status: 502 });
  }

  // A redirect would hand the customer's client the platform's address (and
  // send its bearer key there). The platform's endpoint never redirects.
  if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
    await upstream.body?.cancel().catch(() => {});
    return Response.json({ error: { message: "The assistant could not be reached. Try again shortly.", type: "server_error" } }, { status: 502 });
  }

  const headers = forwardResponseHeaders(upstream);
  if ((headers.get("content-type") || "").includes("text/event-stream")) {
    // Deliver each event as it is written: no compression, no proxy buffering.
    headers.set("Cache-Control", "no-cache, no-transform");
    headers.set("X-Accel-Buffering", "no");
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
}

export const GET = pass;
export const HEAD = pass;
export const POST = pass;
export const PUT = pass;
export const PATCH = pass;
export const DELETE = pass;
export const OPTIONS = pass;

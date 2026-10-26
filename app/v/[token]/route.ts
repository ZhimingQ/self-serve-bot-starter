import { forwardRequestHeaders, forwardResponseHeaders, platformFetch } from "../../../lib/linkProxy";

/**
 * GET /v/<token> — the one-time page where a customer types a login or a
 * verification code for their assistant, on this storefront's own domain.
 *
 * The assistant posts this link in the customer's chat when a website asks it
 * to sign in. The platform serves a self-contained, unbranded page with its own
 * strict Content-Security-Policy; this route passes it through byte for byte,
 * headers included. The page then talks only to /api/vault-prompt/<token> on
 * this same domain (app/api/vault-prompt/[token]).
 */

export const dynamic = "force-dynamic";

const TOKEN_SHAPE = /^[0-9a-f]{32}$/;
const GONE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link expired</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#1f2328;padding:16px"><div style="max-width:420px;background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:28px 24px"><h1 style="font-size:20px;margin:0 0 8px">This link has expired</h1><p style="margin:0;color:#57606a">Ask your assistant to try again and it will send a new one.</p></div></body></html>`;

function gone(status: number): Response {
  return new Response(GONE_HTML, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || !TOKEN_SHAPE.test(token)) return gone(404);
  const upstream = await platformFetch(`/v/${token}`, {
    method: "GET",
    headers: forwardRequestHeaders(request, { accept: "text/html" }),
    signal: request.signal,
  });
  if (!upstream || upstream.status !== 200) {
    void upstream?.body?.cancel().catch(() => {});
    return gone(upstream ? 404 : 502);
  }
  return new Response(upstream.body, { status: 200, headers: forwardResponseHeaders(upstream) });
}

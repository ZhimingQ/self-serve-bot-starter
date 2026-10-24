import { brand } from "../../../lib/config";
import { forwardRequestHeaders, forwardResponseHeaders, platformFetch, visitorHeaders } from "../../../lib/linkProxy";
import { clientIp, rateLimit } from "../../../lib/rateLimit";

/**
 * GET /d/<id> — a file the assistant sent, on this storefront's own domain.
 *
 * The platform mints the link (a 30-minute capability id) and serves the file at
 * the same path; this route streams it through unchanged, Range requests
 * included, so large downloads can resume. Errors get this storefront's own
 * page: the platform's carries the platform's name.
 */

export const dynamic = "force-dynamic";

const ID_SHAPE = /^[A-Za-z0-9_-]{8,32}$/;
const PASS_STATUSES = new Set([200, 206, 304, 416]);

const COPY: Record<number, { title: string; detail: string }> = {
  404: { title: "Link expired or file unavailable", detail: "Download links work for 30 minutes, and the file has to still be with your assistant. Ask it to send the file again." },
  409: { title: "Your assistant is offline", detail: "This file comes straight from your assistant, which isn’t running right now. Start it and ask again." },
  413: { title: "File too large", detail: "This file is too large to download through this link." },
  429: { title: "Too many requests", detail: "Please wait a moment and try again." },
  502: { title: "Couldn’t fetch the file", detail: "Something went wrong reaching your assistant. Ask it to send the file again." },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function errorResponse(request: Request, status: number): Response {
  const code = COPY[status] ? status : 502;
  const c = COPY[code];
  if (!(request.headers.get("accept") || "").includes("text/html")) {
    return Response.json({ error: c.title }, { status: code, headers: { "Cache-Control": "no-store" } });
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(c.title)} · ${esc(brand.name)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f7f8;color:#1f2328;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
.card{max-width:440px;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:32px;text-align:center}
h1{font-size:20px;margin:0 0 10px}
p{margin:0;color:#57606a}
a{display:inline-block;margin-top:20px;color:${esc(brand.readableAccent || "#4f46e5")};text-decoration:none;font-size:14px}
</style></head><body><div class="card">
<h1>${esc(c.title)}</h1><p>${esc(c.detail)}</p><a href="/">${esc(brand.name)}</a>
</div></body></html>`;
  return new Response(html, { status: code, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function serve(request: Request, params: Promise<{ id: string }>, method: "GET" | "HEAD"): Promise<Response> {
  const { id } = await params;
  if (!id || !ID_SHAPE.test(id)) return errorResponse(request, 404);

  // The platform limits /d per IP, and every customer of this storefront reaches
  // it from this server's one address, so the per-visitor limit lives here.
  const rl = await rateLimit("download-link", clientIp(request), 120, 60);
  if (!rl.ok) return errorResponse(request, 429);

  // JSON errors, never the platform's branded HTML page.
  const upstream = await platformFetch(`/d/${encodeURIComponent(id)}`, {
    method,
    headers: forwardRequestHeaders(request, { accept: "application/json", ...visitorHeaders(request) }),
  });
  if (!upstream) return errorResponse(request, 502);
  if (!PASS_STATUSES.has(upstream.status)) {
    await upstream.body?.cancel().catch(() => {});
    return errorResponse(request, upstream.status);
  }
  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: forwardResponseHeaders(upstream),
  });
}

export function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return serve(request, params, "GET");
}

export function HEAD(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return serve(request, params, "HEAD");
}

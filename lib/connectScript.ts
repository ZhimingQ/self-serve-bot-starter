import "server-only";
import { platformFetch } from "./linkProxy";

/**
 * The "My Computer" connect scripts, served from this storefront's own domain
 * so the command a customer pastes names this domain. Fetched from the
 * platform unchanged (the script then talks to the platform itself) and kept
 * for ten minutes.
 */
const TTL_MS = 10 * 60_000;
const MAX_BYTES = 256 * 1024;
const cache = new Map<string, { body: string; until: number }>();

export async function connectScript(name: "connect.sh" | "connect.ps1"): Promise<Response> {
  const now = Date.now();
  let hit = cache.get(name);
  if (!hit || hit.until <= now) {
    const res = await platformFetch(`/${name}`, { method: "GET", headers: { accept: "text/plain", "accept-encoding": "identity" } });
    const body = res && res.status === 200 ? await res.text().catch(() => "") : "";
    if (body && body.length <= MAX_BYTES) {
      hit = { body, until: now + TTL_MS };
      cache.set(name, hit);
    } else if (!hit) {
      return new Response("# Could not load the connect script. Try again in a moment.\n", { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
  }
  return new Response(hit.body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

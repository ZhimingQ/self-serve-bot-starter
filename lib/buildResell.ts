/**
 * Server-only client for the OpenClaw Launch "Build & Resell" API.
 *
 * NEVER import this from a client component. `buildResellApiKey` is a
 * secret and must only ever be read on the server (Route Handlers).
 *
 * API contract:
 *  - POST {base}/instances                → create a bot
 *  - GET  {base}/instances                → list bots
 *  - POST {base}/responses (SSE)          → chat with a bot
 */

// Hard guard: throws at build time if this module is ever imported into a
// client component, so the secret API key can never be bundled to the browser.
import "server-only";
import { brand, buildResellApiKey } from "./config";

export interface BuildResellInstance {
  id: string;
  status: string;
  framework: string;
  server?: string;
  api_server_port?: number;
  created_at?: string;
}

interface ListInstancesResponse {
  data: BuildResellInstance[];
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  if (!buildResellApiKey) {
    throw new Error(
      "BUILD_RESELL_API_KEY is not set. Add your sk_live_... key from the Build & Resell dashboard to .env."
    );
  }
  return {
    Authorization: `Bearer ${buildResellApiKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// Timeout for the non-streaming control calls (create / list). The streaming
// chat call is deliberately NOT timed this way — an AbortSignal would truncate a
// long reply mid-stream — so only the request-boot calls get a hard ceiling.
const CONTROL_TIMEOUT_MS = 20_000;

/** Create a brand-new bot instance for a user. Takes ~30-90s to become reachable. */
export async function createInstance(): Promise<BuildResellInstance> {
  const res = await fetch(`${brand.apiBase}/instances`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ framework: brand.framework }),
    cache: "no-store",
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createInstance failed (${res.status}): ${text}`);
  }

  return (await res.json()) as BuildResellInstance;
}

/** List all bot instances visible to this API key. */
export async function listInstances(): Promise<BuildResellInstance[]> {
  const res = await fetch(`${brand.apiBase}/instances`, {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`listInstances failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as ListInstancesResponse;
  return body.data ?? [];
}

/** Look up a single instance by id (used to poll for "running" status). */
export async function getInstance(instanceId: string): Promise<BuildResellInstance | null> {
  const instances = await listInstances();
  return instances.find((instance) => instance.id === instanceId) ?? null;
}

export interface StreamResponseParams {
  instanceId: string;
  input: string;
  sessionId?: string | null;
}

/**
 * Kick off a chat turn. Returns the raw upstream `Response` so the caller
 * (an API route) can pipe the SSE body straight through to the browser
 * without buffering, and can also read the `x-openclaw-session-id` header
 * off it to persist multi-turn memory.
 */
export async function streamResponse({
  instanceId,
  input,
  sessionId,
}: StreamResponseParams): Promise<Response> {
  const res = await fetch(`${brand.apiBase}/responses`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      instance_id: instanceId,
      input,
      session_id: sessionId ?? undefined,
      stream: true,
    }),
    cache: "no-store",
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`streamResponse failed (${res.status}): ${text}`);
  }

  return res;
}

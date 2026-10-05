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

export class BuildResellApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    operation: "createInstance" | "listInstances" | "deleteInstance",
  ) {
    super(`${operation} failed (${status})${code ? `: ${code}` : ""}`);
    this.name = "BuildResellApiError";
  }
}

async function upstreamError(
  res: Response,
  operation: "createInstance" | "listInstances" | "deleteInstance",
): Promise<BuildResellApiError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const code = typeof body?.error === "string" ? body.error : null;
  return new BuildResellApiError(res.status, code, operation);
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

// Timeout for the quick control calls (list / get / delete). The streaming chat
// call is deliberately NOT timed this way — an AbortSignal would truncate a long
// reply mid-stream — so only the request-boot calls get a hard ceiling.
const CONTROL_TIMEOUT_MS = 20_000;

// Creating an instance is the slow one and needs its own budget. An OpenClaw bot
// is claimed from the warm pool in seconds, but a Hermes bot takes appreciably
// longer to create, which blew straight through the 20s control ceiling: the
// customer got an error while the bot was created anyway, leaving an orphan the
// storefront never recorded (see the comment in api/provision). 90s clears Hermes
// with room to spare and still lands inside the ~100s edge-proxy limit, so the
// customer sees our error rather than a raw gateway timeout.
const CREATE_TIMEOUT_MS = 90_000;

/** Create a brand-new bot instance for a user. Takes ~30-90s to become reachable. */
export async function createInstance(): Promise<BuildResellInstance> {
  const res = await fetch(`${brand.apiBase}/instances`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ framework: brand.framework }),
    cache: "no-store",
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw await upstreamError(res, "createInstance");
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
    throw await upstreamError(res, "listInstances");
  }

  const body = (await res.json()) as ListInstancesResponse;
  return body.data ?? [];
}

/** Look up a single instance by id (used to poll for "running" status). */
export async function getInstance(instanceId: string): Promise<BuildResellInstance | null> {
  const instances = await listInstances();
  return instances.find((instance) => instance.id === instanceId) ?? null;
}

/** Permanently retire a customer's bot. A missing bot is already deleted, so
 *  retries remain safe after a partial account-deletion attempt. */
export async function deleteInstance(instanceId: string): Promise<void> {
  const res = await fetch(`${brand.apiBase}/instances/${encodeURIComponent(instanceId)}`, {
    method: "DELETE",
    headers: authHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });

  if (!res.ok && res.status !== 404) {
    throw await upstreamError(res, "deleteInstance");
  }
}

// ── Customer self-service: model key + channels ──────────────────────────────
// Both of these act on ONE customer's bot with YOUR api key, so every caller must
// have resolved the instance id from the signed-in session first — never from
// anything the browser sent. The two helpers below deliberately return the
// upstream status and body instead of throwing: these endpoints answer with
// meaningful, already-sanitized errors ("that key was rejected", "code expired")
// that the customer needs to read, and collapsing them into a generic failure
// would leave someone staring at a form with no idea what to fix.

export interface UpstreamResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  body: T;
}

async function callApi<T = Record<string, unknown>>(
  path: string,
  init: { method: "GET" | "POST" | "PUT"; body?: unknown },
): Promise<UpstreamResult<T>> {
  const res = await fetch(`${brand.apiBase}${path}`, {
    method: init.method,
    headers: authHeaders(),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, body };
}

/** Is a customer key on file for this bot, and for which provider? Never the key. */
export function getModelKey(instanceId: string) {
  return callApi(`/instances/${encodeURIComponent(instanceId)}/model-key`, { method: "GET" });
}

/** Point the bot at the customer's own provider key, or rotate the one on file.
 *  The platform validates the key against the provider BEFORE switching, so a
 *  bad key is refused rather than silently muting a working assistant. */
export function setModelKey(instanceId: string, modelKey: string, provider?: string) {
  return callApi(`/instances/${encodeURIComponent(instanceId)}/model-key`, {
    method: "PUT",
    body: { model_key: modelKey, ...(provider ? { model_key_provider: provider } : {}) },
  });
}

/** Which channels are connected, and which ones this bot's framework supports. */
export function getChannels(instanceId: string) {
  return callApi(`/instances/${encodeURIComponent(instanceId)}/channels`, { method: "GET" });
}

/** connect | qr | pairing_approve | disconnect. See the channels endpoint docs. */
export function channelAction(instanceId: string, body: Record<string, unknown>) {
  return callApi(`/instances/${encodeURIComponent(instanceId)}/channels`, { method: "POST", body });
}

// ── Customer self-service: bot tools ─────────────────────────────────────────
// Power, backup, SSH, files, API endpoint, desktop, "my computer" and import.
// Same contract as above: the caller has resolved `instanceId` from the session.
//
// The sub-path is a CLOSED set of literals, so no string the browser sent can
// ever become part of an upstream URL path — browser input only reaches the
// query string (encoded by URLSearchParams) or a JSON body the route built
// field by field. The one path segment that is not a literal, a computer
// connection id, has its own function below and is UUID-checked there.

export type BotToolPath =
  | ""
  | "/start"
  | "/stop"
  | "/restart"
  | "/export"
  | "/ssh"
  | "/files"
  | "/files/content"
  | "/files/mkdir"
  | "/files/rename"
  | "/endpoint"
  | "/desktop"
  | "/computer"
  | "/computer/approve"
  | "/import/preview"
  | "/import/apply";

export interface BotToolRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string>;
  /** A JSON body, serialized here. */
  json?: unknown;
  /** A pre-built streamed body (uploads), sent with `contentType`. */
  stream?: ReadableStream<Uint8Array>;
  contentType?: string;
  /** Exact byte length of `stream`, sent as Content-Length instead of chunked
   *  encoding. fetch fails the request if the stream does not match it. */
  contentLength?: number;
  /** Hard ceiling for the whole call. Omitted for downloads, which are bounded
   *  by `signal` (the customer's own request) instead: a timeout would cut a
   *  large backup off mid-stream. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

function botToolUrl(instanceId: string, path: string, query?: Record<string, string>): string {
  const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
  return `${brand.apiBase}/instances/${encodeURIComponent(instanceId)}${path}${qs}`;
}

async function botToolSend(instanceId: string, path: string, req: BotToolRequest): Promise<Response> {
  const signals: AbortSignal[] = [];
  if (req.timeoutMs) signals.push(AbortSignal.timeout(req.timeoutMs));
  if (req.signal) signals.push(req.signal);
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: authHeaders({
      ...(req.contentType ? { "Content-Type": req.contentType } : {}),
      ...(req.stream && req.contentLength !== undefined ? { "Content-Length": String(req.contentLength) } : {}),
    }),
    cache: "no-store",
    ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
  };
  if (req.stream) {
    init.body = req.stream;
    // Required by fetch for a streamed request body.
    init.duplex = "half";
  } else if (req.json !== undefined) {
    init.body = JSON.stringify(req.json);
  }
  return fetch(botToolUrl(instanceId, path, req.query), init);
}

/** One bot-tool call, answered as status + parsed JSON body (never throws on a
 *  non-2xx; the route maps the platform's error code for the customer). */
export async function botToolCall<T = Record<string, unknown>>(
  instanceId: string,
  path: BotToolPath,
  req: BotToolRequest,
): Promise<UpstreamResult<T>> {
  const res = await botToolSend(instanceId, path, { timeoutMs: CONTROL_TIMEOUT_MS, ...req });
  const body = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, body };
}

/** The same, returning the raw Response so a download can be piped straight
 *  through to the customer without buffering it. */
export function botToolRaw(instanceId: string, path: BotToolPath, req: BotToolRequest): Promise<Response> {
  return botToolSend(instanceId, path, req);
}

/** Disconnect one computer from the bot. The id must already be a UUID; it is
 *  checked again here because it is the only non-literal path segment. */
export async function computerDisconnect(instanceId: string, connectionId: string): Promise<UpstreamResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) {
    return { ok: false, status: 404, body: { error: "connection_not_found" } };
  }
  const res = await botToolSend(instanceId, `/computer/${connectionId}`, { method: "DELETE", timeoutMs: CONTROL_TIMEOUT_MS * 3 });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
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

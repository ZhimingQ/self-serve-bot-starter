/**
 * Server side of the "Bot tools" panel: the explicit allowlist of actions a
 * signed-in customer may run against THEIR OWN assistant, and how each one maps
 * onto exactly one platform call.
 *
 * app/api/bot-tools/[action]/route.ts is a thin dispatcher over BOT_TOOL_ACTIONS
 * below. It does the parts every action shares, in this order, before any
 * handler runs: the action must be in this table for that HTTP method; the tool
 * it belongs to must be enabled in BOT_TOOLS (404 otherwise); the customer must
 * be signed in; the per-customer rate limit for that action must allow it; and
 * the instance id comes from the store, keyed by the SESSION's user id. A
 * handler therefore never sees an instance id the browser chose, and there is
 * no generic passthrough: an action not listed here does not exist.
 *
 * What goes back to the browser is re-shaped field by field, and errors are
 * reduced to a short code from a known list that the UI localizes. The
 * platform's own error sentences are never forwarded: they are written for the
 * reseller and can name the underlying stack, which this white-label UI must
 * not show.
 */
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { botToolCall, botToolRaw, computerDisconnect, type UpstreamResult } from "./buildResell";
import { enabledBotTools } from "./config";
import {
  attachmentDisposition,
  backupCategories,
  base64JsonStream,
  cleanFilePath,
  cleanFolderList,
  exportCategoriesFor,
  importableCategories,
  isUuid,
  looksLikeTailscaleAuthKey,
  multipartStream,
  normalizePairingCode,
  parseCategoryList,
  type BotToolId,
} from "./botTools";

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface ToolContext {
  request: NextRequest;
  userId: string;
  instanceId: string;
}

export interface ActionSpec {
  /** The BOT_TOOLS entry this action belongs to; null for the shared status
   *  read, which exists whenever any tool does. */
  tool: BotToolId | null;
  /** Per-customer ceiling. Every action that changes anything has one. */
  limit?: { max: number; windowSec: number };
  run: (ctx: ToolContext) => Promise<Response>;
}

// Platform limits mirrored here so a customer is refused before uploading.
export const MAX_FILE_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

const NO_STORE = { "Cache-Control": "private, no-store" };

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const fail = (error: string, status: number, extra?: Record<string, unknown>) =>
  NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });

/** Every error code the UI knows how to explain. Anything else from the
 *  platform collapses to "upstream_error". */
const KNOWN_ERRORS = new Set([
  "not_available",
  "service_unavailable",
  "rate_limited",
  "bot_not_running",
  "bot_not_ready",
  "not_ready",
  "invalid_state",
  "instance_quota_exceeded",
  "invalid_categories",
  "export_in_progress",
  "export_failed",
  "invalid_auth_key",
  "auth_key_rejected",
  "auth_key_expired",
  "ssh_unavailable",
  "install_failed",
  "daemon_failed",
  "disconnect_unconfirmed",
  "bad_path",
  "is_a_directory",
  "file_not_found",
  "file_too_large",
  "managed_file",
  "sha_mismatch",
  "busy",
  "files_unavailable",
  "endpoint_disabled",
  "rotation_unsupported",
  "conflict",
  "endpoint_unavailable",
  "desktop_unavailable",
  "pairing_not_found",
  "invalid_user_code",
  "invalid_folders",
  "bot_reachable_by_others",
  "fix_failed",
  "connection_not_found",
  "archive_too_large",
  "invalid_archive",
  "missing_manifest",
  "wrong_framework",
  "import_in_progress",
  "server_busy",
  "upload_timeout",
  "length_required",
  "import_rolled_back",
  "import_failed",
  "key_required",
  "invalid_key",
  "invalid_model",
  "model_not_allowed",
  "provider_not_allowed",
  "bot_update_required",
  "video_failed",
  "included_video_off",
]);

/** Map a failed platform call to a customer-safe status + code. */
function upstreamFailure(result: Pick<UpstreamResult, "status" | "body">, extra?: Record<string, unknown>): Response {
  const raw = (result.body as { error?: unknown }).error;
  const code = typeof raw === "string" ? raw : "";
  const { status } = result;
  // The reseller's own account standing (key, plan) is not something the
  // customer can fix, and must not be described to them.
  if (status === 401 || status === 402 || status === 403) return fail("service_unavailable", 503);
  if (status === 404 && (code === "not_found" || !KNOWN_ERRORS.has(code))) return fail("not_available", 404);
  if (status === 429) return fail(code === "export_in_progress" || code === "import_in_progress" || code === "server_busy" || code === "busy" ? code : "rate_limited", 429);
  const safe = KNOWN_ERRORS.has(code) ? code : "upstream_error";
  const mapped = status >= 500 ? (status === 503 ? 503 : 502) : status >= 400 ? status : 502;
  return fail(safe, mapped, extra);
}

function dataOf(result: UpstreamResult): Record<string, unknown> {
  const data = (result.body as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function readJson(request: NextRequest): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 16 * 1024) return null;
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The kind of bot ("openclaw" | "hermes") and its live status. Server-side
 *  only: the kind decides which backup categories apply, and is never sent to
 *  the browser. */
async function botState(instanceId: string): Promise<{ ok: true; status: string; kind: string } | { ok: false; response: Response }> {
  const result = await botToolCall(instanceId, "", { method: "GET" });
  if (!result.ok) return { ok: false, response: upstreamFailure(result) };
  const data = dataOf(result);
  return { ok: true, status: str(data.status) ?? "unknown", kind: str(data.framework) ?? "openclaw" };
}

// ── Info + power ────────────────────────────────────────────────────────────

const info: ActionSpec = {
  tool: null,
  limit: { max: 240, windowSec: 600 },
  async run({ instanceId }) {
    const state = await botState(instanceId);
    if (!state.ok) return state.response;
    return json({
      status: state.status,
      tools: enabledBotTools,
      backupCategories: exportCategoriesFor(state.kind),
    });
  },
};

const POWER_OPS = { start: "/start", stop: "/stop", restart: "/restart" } as const;

const power: ActionSpec = {
  tool: "power",
  limit: { max: 10, windowSec: 600 },
  async run({ request, instanceId }) {
    const body = await readJson(request);
    const op = body?.op;
    if (op !== "start" && op !== "stop" && op !== "restart") return fail("invalid_request", 400);
    // Restart and start can take a minute or two on a cold bot.
    const result = await botToolCall(instanceId, POWER_OPS[op], { method: "POST", timeoutMs: 150_000 });
    if (!result.ok) return upstreamFailure(result);
    return json({ status: str(dataOf(result).status) ?? "unknown" });
  },
};

// ── Backup ──────────────────────────────────────────────────────────────────

const backup: ActionSpec = {
  tool: "backup",
  // An archive is expensive to build on the platform side.
  limit: { max: 6, windowSec: 3600 },
  async run({ request, instanceId }) {
    const categories = parseCategoryList(request.nextUrl.searchParams.get("categories"), backupCategories);
    if (!categories) return fail("invalid_categories", 400);
    const upstream = await botToolRaw(instanceId, "/export", {
      method: "GET",
      query: { categories: categories.join(",") },
      // Bound by the customer's own request: if they cancel, the build stops.
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const body = await upstream.json().catch(() => ({}));
      return upstreamFailure({ status: upstream.ok ? 502 : upstream.status, body });
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    // Streamed straight through: the archive is never held in this process.
    // Our own file name, not the platform's, which names the underlying stack.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": attachmentDisposition(`assistant-backup-${stamp}.zip`),
        ...NO_STORE,
      },
    });
  },
};

// ── SSH ─────────────────────────────────────────────────────────────────────

function sshView(data: Record<string, unknown>) {
  return {
    connected: data.connected === true,
    enrolled: data.enrolled === true,
    sshEnabled: data.ssh_enabled === true,
    dnsName: str(data.dns_name),
    tailnetIp: str(data.tailnet_ipv4),
    sshUser: str(data.ssh_user),
    sshCommand: str(data.ssh_command),
    // The platform's warning text is for the reseller; the customer only needs
    // to know something was off.
    warning: typeof data.warning === "string",
  };
}

const sshStatus: ActionSpec = {
  tool: "ssh",
  limit: { max: 120, windowSec: 600 },
  async run({ instanceId }) {
    const result = await botToolCall(instanceId, "/ssh", { method: "GET", timeoutMs: 60_000 });
    if (!result.ok) return upstreamFailure(result);
    return json(sshView(dataOf(result)));
  },
};

const sshConnect: ActionSpec = {
  tool: "ssh",
  limit: { max: 6, windowSec: 600 },
  async run({ request, instanceId }) {
    const body = await readJson(request);
    const authKey = body?.authKey;
    if (!looksLikeTailscaleAuthKey(authKey)) return fail("invalid_auth_key", 400);
    // First connect installs Tailscale inside the assistant; allow for it.
    const result = await botToolCall(instanceId, "/ssh", {
      method: "POST",
      json: { auth_key: authKey.trim() },
      timeoutMs: 300_000,
    });
    if (!result.ok) return upstreamFailure(result);
    return json(sshView(dataOf(result)));
  },
};

const sshDisconnect: ActionSpec = {
  tool: "ssh",
  limit: { max: 6, windowSec: 600 },
  async run({ instanceId }) {
    const result = await botToolCall(instanceId, "/ssh", { method: "DELETE", timeoutMs: 90_000 });
    if (!result.ok) return upstreamFailure(result);
    return json(sshView(dataOf(result)));
  },
};

// ── Files ───────────────────────────────────────────────────────────────────

const filesList: ActionSpec = {
  tool: "files",
  limit: { max: 600, windowSec: 600 },
  async run({ request, instanceId }) {
    const path = cleanFilePath(request.nextUrl.searchParams.get("path"), { allowRoot: true });
    if (path === null) return fail("bad_path", 400);
    const result = await botToolCall(instanceId, "/files", { method: "GET", query: { path }, timeoutMs: 60_000 });
    if (!result.ok) return upstreamFailure(result);
    const data = dataOf(result);
    const entries = (Array.isArray(data.entries) ? data.entries : []).slice(0, 5000).map((raw) => {
      const e = (raw ?? {}) as Record<string, unknown>;
      return { name: str(e.name) ?? "", isDir: e.is_dir === true, size: num(e.size), modifiedAt: str(e.modified_at) };
    }).filter((e) => e.name && e.name !== "." && e.name !== "..");
    return json({ path: str(data.path) ?? path, entries });
  },
};

const filesDelete: ActionSpec = {
  tool: "files",
  limit: { max: 60, windowSec: 600 },
  async run({ request, instanceId }) {
    const path = cleanFilePath(request.nextUrl.searchParams.get("path"), { allowRoot: false });
    if (path === null) return fail("bad_path", 400);
    const result = await botToolCall(instanceId, "/files", { method: "DELETE", query: { path }, timeoutMs: 60_000 });
    if (!result.ok) return upstreamFailure(result);
    return json({ deleted: true });
  },
};

const fileDownload: ActionSpec = {
  tool: "files",
  limit: { max: 120, windowSec: 600 },
  async run({ request, instanceId }) {
    const path = cleanFilePath(request.nextUrl.searchParams.get("path"), { allowRoot: false });
    if (path === null) return fail("bad_path", 400);
    // The platform answers one file as JSON (base64, capped at 25 MB), so this
    // one is decoded here rather than piped.
    const result = await botToolCall(instanceId, "/files/content", { method: "GET", query: { path }, timeoutMs: 120_000 });
    if (!result.ok) return upstreamFailure(result);
    const content = str(dataOf(result).content_base64);
    if (content === null) return fail("upstream_error", 502);
    const bytes = Buffer.from(content, "base64");
    const name = path.split("/").pop() || "download";
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Content-Disposition": attachmentDisposition(name),
        "X-Content-Type-Options": "nosniff",
        ...NO_STORE,
      },
    });
  },
};

const fileUpload: ActionSpec = {
  tool: "files",
  limit: { max: 30, windowSec: 600 },
  async run({ request, instanceId }) {
    const path = cleanFilePath(request.nextUrl.searchParams.get("path"), { allowRoot: false });
    if (path === null) return fail("bad_path", 400);
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_FILE_UPLOAD_BYTES) return fail("file_too_large", 413);
    if (!request.body) return fail("invalid_request", 400);
    // The browser sends the raw bytes; they are base64-encoded on the way
    // through, never collected in memory first.
    const { stream, cap } = base64JsonStream(request.body, { field: "content_base64", max: MAX_FILE_UPLOAD_BYTES });
    try {
      const result = await botToolCall(instanceId, "/files/content", {
        method: "PUT",
        query: { path },
        stream,
        contentType: "application/json",
        timeoutMs: 180_000,
      });
      if (!result.ok) return upstreamFailure(result);
      return json({ path, size: num(dataOf(result).size) });
    } catch (err) {
      if (cap.exceeded) return fail("file_too_large", 413);
      throw err;
    }
  },
};

const filesMkdir: ActionSpec = {
  tool: "files",
  limit: { max: 60, windowSec: 600 },
  async run({ request, instanceId }) {
    const body = await readJson(request);
    const path = cleanFilePath(body?.path, { allowRoot: false });
    if (path === null) return fail("bad_path", 400);
    const result = await botToolCall(instanceId, "/files/mkdir", { method: "POST", json: { path }, timeoutMs: 60_000 });
    if (!result.ok) return upstreamFailure(result);
    return json({ path });
  },
};

const filesRename: ActionSpec = {
  tool: "files",
  limit: { max: 60, windowSec: 600 },
  async run({ request, instanceId }) {
    const body = await readJson(request);
    const from = cleanFilePath(body?.from, { allowRoot: false });
    const to = cleanFilePath(body?.to, { allowRoot: false });
    if (from === null || to === null) return fail("bad_path", 400);
    const result = await botToolCall(instanceId, "/files/rename", { method: "POST", json: { from, to }, timeoutMs: 60_000 });
    if (!result.ok) return upstreamFailure(result);
    return json({ from, to });
  },
};

// ── API endpoint ────────────────────────────────────────────────────────────

function endpointView(data: Record<string, unknown>) {
  return {
    enabled: data.enabled === true,
    baseUrl: str(data.base_url),
    rotationSupported: data.rotation_supported === true,
  };
}

const endpointStatus: ActionSpec = {
  tool: "endpoint",
  limit: { max: 120, windowSec: 600 },
  async run({ instanceId }) {
    const result = await botToolCall(instanceId, "/endpoint", { method: "GET" });
    if (!result.ok) return upstreamFailure(result);
    return json(endpointView(dataOf(result)));
  },
};

const endpointMutate: ActionSpec = {
  tool: "endpoint",
  limit: { max: 10, windowSec: 600 },
  async run({ request, instanceId }) {
    const body = await readJson(request);
    const action = body?.action;
    if (action !== "enable" && action !== "rotate") return fail("invalid_request", 400);
    // No allowed_origin: the customer's own apps call server-to-server. A
    // browser origin would let a web page hold the key, which is a decision
    // this panel does not offer.
    const result = await botToolCall(instanceId, "/endpoint", { method: "POST", json: { action }, timeoutMs: 120_000 });
    if (!result.ok) return upstreamFailure(result);
    const data = dataOf(result);
    // The key is in this one response and nowhere else; the panel shows it once.
    return json({ ...endpointView(data), apiKey: str(data.api_key), curlExample: str(data.curl_example) });
  },
};

const endpointDisable: ActionSpec = {
  tool: "endpoint",
  limit: { max: 10, windowSec: 600 },
  async run({ instanceId }) {
    const result = await botToolCall(instanceId, "/endpoint", { method: "DELETE", timeoutMs: 60_000 });
    if (!result.ok) return upstreamFailure(result);
    return json(endpointView(dataOf(result)));
  },
};

// ── Video (the customer's own provider key) ─────────────────────────────────
// Hermes assistants only; the platform answers 404 for any other kind, which
// the panel shows as "not available". The key is the CUSTOMER's: it pays for
// their videos, is validated by the platform before the assistant is touched,
// and only a masked preview ever comes back.

function modelList(raw: unknown, providers: readonly string[]) {
  return (Array.isArray(raw) ? raw : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({ id: str(m.id) ?? "", label: str(m.label) ?? "", provider: str(m.provider) ?? "", price: str(m.price) }))
    .filter((m) => m.id && providers.includes(m.provider));
}

function videoView(data: Record<string, unknown>) {
  const previews = data.key_previews && typeof data.key_previews === "object" ? (data.key_previews as Record<string, unknown>) : {};
  const included = data.included && typeof data.included === "object" ? (data.included as Record<string, unknown>) : {};
  const budget = num(included.monthly_budget_usd) ?? 0;
  const spent = num(included.spent_usd_this_month) ?? 0;
  return {
    model: str(data.model),
    keyPreviews: { fal: str(previews.fal), google: str(previews.google) },
    models: modelList(data.models, ["fal", "google"]),
    // Included video (paid by the seller): models plus how much of this
    // month's allowance is used, as a percentage. The seller's dollar budget
    // and their cost are not the customer's business, so no amounts here.
    included: budget > 0
      ? { models: modelList(included.models, ["openrouter"]).map((m) => ({ ...m, price: null })), usedPercent: Math.min(100, Math.round((spent / budget) * 100)) }
      : null,
  };
}

const videoStatus: ActionSpec = {
  tool: "video",
  limit: { max: 120, windowSec: 600 },
  async run({ instanceId }) {
    const result = await botToolCall(instanceId, "/video", { method: "GET" });
    if (!result.ok) return upstreamFailure(result);
    return json(videoView(dataOf(result)));
  },
};

const videoSet: ActionSpec = {
  tool: "video",
  limit: { max: 10, windowSec: 600 },
  async run({ request, instanceId }) {
    const body = await readJson(request);
    const model = body?.model;
    const key = body?.key;
    if (typeof model !== "string" || !model || model.length > 200) return fail("invalid_model", 400);
    if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 512)) return fail("invalid_key", 400);
    // Switching restarts the assistant with the new setting.
    const result = await botToolCall(instanceId, "/video", {
      method: "PUT",
      json: key === undefined ? { model } : { model, key: (key as string).trim() },
      timeoutMs: 150_000,
    });
    if (!result.ok) return upstreamFailure(result);
    return json({ model: str(dataOf(result).model) });
  },
};

// ── Desktop ─────────────────────────────────────────────────────────────────

const desktopStatus: ActionSpec = {
  tool: "desktop",
  limit: { max: 120, windowSec: 600 },
  async run({ instanceId }) {
    const result = await botToolCall(instanceId, "/desktop", { method: "GET" });
    if (!result.ok) return upstreamFailure(result);
    const data = dataOf(result);
    return json({ available: data.available === true, reason: str(data.reason) });
  },
};

const desktopOpen: ActionSpec = {
  tool: "desktop",
  limit: { max: 10, windowSec: 600 },
  async run({ instanceId }) {
    const result = await botToolCall(instanceId, "/desktop", { method: "POST", timeoutMs: 60_000 });
    if (!result.ok) return upstreamFailure(result);
    const data = dataOf(result);
    const viewerUrl = str(data.viewer_url);
    // The browser navigates a tab to this, so only an https URL is passed on.
    let safe: string | null = null;
    try {
      if (viewerUrl && new URL(viewerUrl).protocol === "https:") safe = viewerUrl;
    } catch {
      safe = null;
    }
    if (!safe) return fail("desktop_unavailable", 502);
    return json({ viewerUrl: safe, expiresAt: str(data.expires_at) });
  },
};

// ── My computer ─────────────────────────────────────────────────────────────

const computerStatus: ActionSpec = {
  tool: "computer",
  limit: { max: 120, windowSec: 600 },
  async run({ instanceId }) {
    const result = await botToolCall(instanceId, "/computer", { method: "GET" });
    if (!result.ok) return upstreamFailure(result);
    const data = dataOf(result);
    const commands = (data.connect_command ?? {}) as Record<string, unknown>;
    const connections = (Array.isArray(data.connections) ? data.connections : []).slice(0, 20).map((raw) => {
      const c = (raw ?? {}) as Record<string, unknown>;
      return {
        id: str(c.id),
        deviceName: str(c.device_name),
        platform: str(c.platform),
        status: str(c.status),
        online: c.online === true,
        folders: Array.isArray(c.folders) ? c.folders.filter((f): f is string => typeof f === "string").slice(0, 10) : [],
        access: c.access === "write" ? "write" : "read",
        terminal: c.terminal === true,
        lastSeenAt: str(c.last_seen_at),
      };
    }).filter((c) => isUuid(c.id));
    return json({
      connections,
      connectCommand: { macosLinux: str(commands.macos_linux), windows: str(commands.windows) },
    });
  },
};

const computerApprove: ActionSpec = {
  tool: "computer",
  limit: { max: 6, windowSec: 600 },
  async run({ request, instanceId }) {
    const body = await readJson(request);
    if (!body) return fail("invalid_request", 400);
    const userCode = normalizePairingCode(body.userCode);
    if (!userCode) return fail("invalid_user_code", 400);
    const folders = cleanFolderList(body.folders);
    if (!folders) return fail("invalid_folders", 400);
    const access = body.access === "write" ? "write" : "read";
    const result = await botToolCall(instanceId, "/computer/approve", {
      method: "POST",
      json: {
        user_code: userCode,
        folders,
        access,
        terminal: body.terminal === true,
        close_telegram_groups: body.closeTelegramGroups === true,
      },
      timeoutMs: 120_000,
    });
    if (!result.ok) {
      const upstream = result.body as { error?: unknown; reasons?: unknown; fix?: unknown };
      if (upstream.error === "bot_reachable_by_others") {
        // The reasons name the chat apps that make the assistant reachable by
        // other people ("Discord is connected"), which the customer needs to see
        // to fix it. Bounded, strings only.
        const reasons = (Array.isArray(upstream.reasons) ? upstream.reasons : [])
          .filter((r): r is string => typeof r === "string")
          .slice(0, 10)
          .map((r) => r.slice(0, 300));
        return fail("bot_reachable_by_others", 409, {
          reasons,
          fix: upstream.fix === "close_telegram_groups" ? "close_telegram_groups" : null,
        });
      }
      return upstreamFailure(result);
    }
    const data = dataOf(result);
    return json({ connectionId: str(data.connection_id), deviceName: str(data.device_name), status: str(data.status) });
  },
};

const computerRemove: ActionSpec = {
  tool: "computer",
  limit: { max: 6, windowSec: 600 },
  async run({ request, instanceId }) {
    const id = request.nextUrl.searchParams.get("id");
    if (!isUuid(id)) return fail("connection_not_found", 404);
    const result = await computerDisconnect(instanceId, id);
    if (!result.ok) return upstreamFailure(result);
    return json({ removed: true });
  },
};

// ── Import ──────────────────────────────────────────────────────────────────

/** Forward the customer's upload as the multipart body the platform expects,
 *  streamed and capped — never buffered whole in this process. */
async function forwardImport(
  ctx: ToolContext,
  path: "/import/preview" | "/import/apply",
  fields: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<{ result: UpstreamResult } | { response: Response }> {
  // The platform needs the exact size up front (it reserves the upload in one
  // buffer and answers 411 without it), so the browser's own Content-Length is
  // required here — fetch() with a File always sends one — and the envelope's
  // size is added to it. The stream still never holds the file in memory, and
  // fails if the body turns out longer or shorter than declared.
  const rawLength = ctx.request.headers.get("content-length");
  const declared = rawLength && /^\d{1,12}$/.test(rawLength) ? Number(rawLength) : NaN;
  if (!Number.isSafeInteger(declared)) return { response: fail("length_required", 411) };
  if (declared > MAX_IMPORT_BYTES) return { response: fail("archive_too_large", 413) };
  if (declared === 0 || !ctx.request.body) return { response: fail("invalid_archive", 400) };
  const boundary = `----bottools${crypto.randomUUID().replace(/-/g, "")}`;
  const { stream, cap, length } = multipartStream(ctx.request.body, {
    boundary,
    fileField: "file",
    filename: "backup.zip",
    contentType: "application/zip",
    fields,
    max: MAX_IMPORT_BYTES,
    expectedBytes: declared,
  });
  try {
    const result = await botToolCall(ctx.instanceId, path, {
      method: "POST",
      stream,
      contentType: `multipart/form-data; boundary=${boundary}`,
      contentLength: length ?? undefined,
      timeoutMs,
    });
    return { result };
  } catch (err) {
    if (cap.exceeded) return { response: fail("archive_too_large", 413) };
    throw err;
  }
}

const importPreview: ActionSpec = {
  tool: "import",
  limit: { max: 6, windowSec: 3600 },
  async run(ctx) {
    const sent = await forwardImport(ctx, "/import/preview", undefined, 150_000);
    if ("response" in sent) return sent.response;
    if (!sent.result.ok) return upstreamFailure(sent.result);
    const data = dataOf(sent.result);
    const manifest = (data.manifest ?? {}) as Record<string, unknown>;
    const allowed = importableCategories as readonly string[];
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : []);
    return json({
      categories: strings(data.categories),
      importableCategories: strings(data.importable_categories).filter((c) => allowed.includes(c)),
      fileCount: num(data.entry_count),
      totalSize: num(data.total_size),
      exportedAt: str(manifest.exported_at),
    });
  },
};

const importApply: ActionSpec = {
  tool: "import",
  limit: { max: 3, windowSec: 3600 },
  async run(ctx) {
    // Categories ride in the query string so they can be validated here
    // without parsing the upload; the multipart envelope is built server-side.
    const categories = parseCategoryList(ctx.request.nextUrl.searchParams.get("categories"), importableCategories);
    if (!categories) return fail("invalid_categories", 400);
    const sent = await forwardImport(ctx, "/import/apply", { categories: categories.join(",") }, 310_000);
    if ("response" in sent) return sent.response;
    if (!sent.result.ok) {
      const body = sent.result.body as { error?: unknown; rollback_complete?: unknown };
      if (body.error === "import_rolled_back") {
        return fail("import_rolled_back", 502, { rollbackComplete: body.rollback_complete === true });
      }
      return upstreamFailure(sent.result);
    }
    const data = dataOf(sent.result);
    return json({
      categories: Array.isArray(data.categories) ? data.categories.filter((c): c is string => typeof c === "string") : categories,
      applied: num(data.applied),
      skipped: num(data.skipped),
      settingsKept: Array.isArray(data.config_keys_ignored) && data.config_keys_ignored.length > 0,
      restarted: data.restarted === true,
    });
  },
};

/**
 * THE allowlist. Storefront action → platform call, by HTTP method:
 *
 *   GET    info            → GET    /v1/instances/{id}
 *   POST   power           → POST   /v1/instances/{id}/{start|stop|restart}
 *   GET    backup          → GET    /v1/instances/{id}/export?categories=
 *   GET    ssh             → GET    /v1/instances/{id}/ssh
 *   POST   ssh             → POST   /v1/instances/{id}/ssh
 *   DELETE ssh             → DELETE /v1/instances/{id}/ssh
 *   GET    files           → GET    /v1/instances/{id}/files?path=
 *   DELETE files           → DELETE /v1/instances/{id}/files?path=
 *   GET    file            → GET    /v1/instances/{id}/files/content?path=   (sent as a download)
 *   PUT    file            → PUT    /v1/instances/{id}/files/content?path=   (raw bytes → base64)
 *   POST   mkdir           → POST   /v1/instances/{id}/files/mkdir
 *   POST   rename          → POST   /v1/instances/{id}/files/rename
 *   GET    endpoint        → GET    /v1/instances/{id}/endpoint
 *   POST   endpoint        → POST   /v1/instances/{id}/endpoint  {enable|rotate}
 *   DELETE endpoint        → DELETE /v1/instances/{id}/endpoint
 *   GET    desktop         → GET    /v1/instances/{id}/desktop
 *   POST   desktop         → POST   /v1/instances/{id}/desktop
 *   GET    computer        → GET    /v1/instances/{id}/computer
 *   POST   computer        → POST   /v1/instances/{id}/computer/approve
 *   DELETE computer?id=    → DELETE /v1/instances/{id}/computer/{uuid}
 *   POST   import-preview  → POST   /v1/instances/{id}/import/preview  (raw zip → multipart)
 *   POST   import-apply    → POST   /v1/instances/{id}/import/apply    (raw zip → multipart)
 *   GET    video           → GET    /v1/instances/{id}/video
 *   PUT    video           → PUT    /v1/instances/{id}/video   {model, key?}
 *
 * To add a tool: add its id to knownBotTools (lib/botTools.ts), its actions
 * here, and one section component in app/app/botTools/.
 */
export const BOT_TOOL_ACTIONS: Record<string, Partial<Record<Method, ActionSpec>>> = {
  info: { GET: info },
  power: { POST: power },
  backup: { GET: backup },
  ssh: { GET: sshStatus, POST: sshConnect, DELETE: sshDisconnect },
  files: { GET: filesList, DELETE: filesDelete },
  file: { GET: fileDownload, PUT: fileUpload },
  mkdir: { POST: filesMkdir },
  rename: { POST: filesRename },
  endpoint: { GET: endpointStatus, POST: endpointMutate, DELETE: endpointDisable },
  desktop: { GET: desktopStatus, POST: desktopOpen },
  computer: { GET: computerStatus, POST: computerApprove, DELETE: computerRemove },
  "import-preview": { POST: importPreview },
  "import-apply": { POST: importApply },
  video: { GET: videoStatus, PUT: videoSet },
};

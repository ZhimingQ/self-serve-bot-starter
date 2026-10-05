/**
 * "Bot tools" — the per-assistant tools a customer can drive from the Manage
 * section of their workspace: power, backup, SSH, files, API endpoint, import,
 * desktop and "my computer".
 *
 * This module is PURE (no node:fs, no imports) so that:
 *   - lib/config.ts and lib/validateEnv.ts can share one parser for BOT_TOOLS,
 *   - the route handlers' input validation is unit-testable with plain
 *     `node --test` (see lib/botTools.test.mjs),
 *   - and it can never accidentally pull a server secret into a client bundle.
 *
 * Everything that talks to the platform lives in lib/botToolsHandlers.ts
 * (server-only). Nothing here decides WHICH bot an action applies to: that is
 * always the signed-in customer's own bot, resolved from the session.
 */

export const knownBotTools = ["power", "backup", "ssh", "files", "endpoint", "import", "desktop", "computer"] as const;
export type BotToolId = (typeof knownBotTools)[number];

/**
 * Parse BOT_TOOLS.
 *
 * Unset or empty means every tool. `none` (or `off`) means no tools at all.
 * Otherwise a comma list; names this storefront does not know are dropped, and a
 * list that names NOTHING recognisable resolves to no tools rather than to all of
 * them — the same reading CHANNELS gets, for the same reason: a misspelt
 * allowlist must not widen into "everything". validateEnv turns that case into
 * a boot failure in production.
 */
export function parseBotTools(raw: string | undefined): BotToolId[] {
  const value = raw?.trim().toLowerCase();
  if (!value) return [...knownBotTools];
  if (value === "none" || value === "off") return [];
  const named = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
  return knownBotTools.filter((id) => named.has(id));
}

/** Production-config problems with BOT_TOOLS, for validateEnv. */
export function botToolsProblems(raw: string | undefined): string[] {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "none" || value === "off") return [];
  const named = value.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = named.filter((s) => !(knownBotTools as readonly string[]).includes(s));
  if (unknown.length === 0) return [];
  return [
    `BOT_TOOLS contains unknown tool(s): ${unknown.join(", ")}. Valid values: ${knownBotTools.join(", ")} ` +
      "(or none). Leave it unset to offer every tool.",
  ];
}

// ── Input validation ────────────────────────────────────────────────────────

/** Every backup category the platform knows. Which of them a given bot accepts
 *  depends on its kind; the platform re-checks and answers 400 otherwise. */
export const backupCategories = ["config", "agents", "skills", "sessions", "knowledge", "credentials"] as const;
export type BackupCategory = (typeof backupCategories)[number];

/** What a bot of each kind can export, in display order. `credentials` is an
 *  inventory of connected apps (never the keys) and exists on one kind only. */
export const exportCategoriesFor = (kind: string): BackupCategory[] =>
  kind === "hermes"
    ? ["config", "agents", "skills", "sessions", "knowledge"]
    : ["config", "agents", "skills", "sessions", "knowledge", "credentials"];

/** The platform's own default backup: how the assistant is set up, nothing
 *  that was said to it. */
export const defaultBackupCategories: BackupCategory[] = ["config", "agents"];

/** Categories an import may restore. `credentials` is never one: no backup
 *  carries keys, and a chat app is restored by connecting it again. */
export const importableCategories = ["config", "agents", "skills", "sessions", "knowledge"] as const;

/** Validate a comma list of categories against an allowlist. Returns null on
 *  anything unknown — a quietly narrowed list would hand back a backup the
 *  customer believes contains something it does not. */
export function parseCategoryList(raw: unknown, allowed: readonly string[]): string[] | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const named = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (named.length === 0) return null;
  if (named.some((c) => !allowed.includes(c))) return null;
  return [...new Set(named)];
}

/**
 * Canonicalize a file path typed or clicked in the browser. Relative to the
 * assistant's data folder; never absolute, never `..`, never a control
 * character. Returns null when the path is not acceptable. The platform applies
 * its own, stricter check as well — this one exists so nothing malformed is
 * forwarded at all.
 */
export function cleanFilePath(raw: unknown, opts: { allowRoot: boolean }): string | null {
  if (raw === undefined || raw === null) raw = "";
  if (typeof raw !== "string" || raw.length > 1024) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (raw.startsWith("/")) return null;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  const rel = parts.join("/");
  if (!rel && !opts.allowRoot) return null;
  return rel;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

/** A Tailscale AUTH key (not an OAuth client secret, not an API key). */
export function looksLikeTailscaleAuthKey(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const v = raw.trim();
  return v.length >= 20 && v.length <= 200 && /^tskey-auth-[A-Za-z0-9-]+$/.test(v);
}

/** The short code a computer prints when it asks to connect, e.g. ABCD-1234.
 *  Letters and digits only once separators are dropped. */
export function normalizePairingCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{6,12}$/.test(code) ? code : null;
}

/** Folder paths ON THE CUSTOMER'S COMPUTER (not on the assistant): 1-10 of
 *  them, short, printable. Their meaning is checked by the platform. */
export function cleanFolderList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) return null;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return null;
    const v = entry.trim();
    // eslint-disable-next-line no-control-regex
    if (!v || v.length > 512 || /[\u0000-\u001f\u007f]/.test(v)) return null;
    out.push(v);
  }
  return [...new Set(out)];
}

// ── Streaming helpers ───────────────────────────────────────────────────────
// Uploads pass THROUGH the storefront instead of being buffered: a 500 MB
// backup held in memory would take a small host down. Both helpers count bytes
// as they flow and stop the moment a cap is passed.

export interface StreamCap {
  /** Set when the incoming body passed `max` bytes; the stream errors then. */
  exceeded: boolean;
  bytes: number;
}

const encoder = new TextEncoder();

/**
 * Wrap a raw upload as a multipart/form-data body: optional text fields first,
 * then the bytes as a file field. Streamed — the upload is never held whole.
 */
export function multipartStream(
  body: ReadableStream<Uint8Array>,
  opts: { boundary: string; fileField: string; filename: string; contentType: string; fields?: Record<string, string>; max: number },
): { stream: ReadableStream<Uint8Array>; cap: StreamCap } {
  const cap: StreamCap = { exceeded: false, bytes: 0 };
  let head = "";
  for (const [name, value] of Object.entries(opts.fields ?? {})) {
    head += `--${opts.boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  head +=
    `--${opts.boundary}\r\nContent-Disposition: form-data; name="${opts.fileField}"; filename="${opts.filename}"\r\n` +
    `Content-Type: ${opts.contentType}\r\n\r\n`;
  const prefix = encoder.encode(head);
  const suffix = encoder.encode(`\r\n--${opts.boundary}--\r\n`);
  const reader = body.getReader();
  let stage = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stage === 0) {
        stage = 1;
        controller.enqueue(prefix);
        return;
      }
      if (stage === 1) {
        const { done, value } = await reader.read();
        if (!done) {
          cap.bytes += value.byteLength;
          if (cap.bytes > opts.max) {
            cap.exceeded = true;
            await reader.cancel().catch(() => {});
            controller.error(new Error("too_large"));
            return;
          }
          controller.enqueue(value);
          return;
        }
        stage = 2;
      }
      controller.enqueue(suffix);
      controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream, cap };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Of(bytes: Uint8Array, final: boolean): { text: string; rest: Uint8Array } {
  const whole = final ? bytes.length : bytes.length - (bytes.length % 3);
  let text = "";
  let i = 0;
  for (; i + 2 < whole; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    text += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (final && i < bytes.length) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const n = (a << 16) | (b << 8);
    text += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + "=";
    i = bytes.length;
  }
  return { text, rest: bytes.slice(i) };
}

/**
 * Turn a raw upload into the JSON body the platform's file-write call takes —
 * `{"content_base64":"..."}` — while streaming, three bytes at a time, so a
 * 50 MB file never sits in memory as a 70 MB string.
 */
export function base64JsonStream(
  body: ReadableStream<Uint8Array>,
  opts: { field: string; max: number },
): { stream: ReadableStream<Uint8Array>; cap: StreamCap } {
  const cap: StreamCap = { exceeded: false, bytes: 0 };
  const reader = body.getReader();
  let carry: Uint8Array = new Uint8Array(0);
  let started = false;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(`{"${opts.field}":"`));
        return;
      }
      if (finished) return;
      // Loop until something is enqueued: a pull that resolves without
      // enqueueing is not called again, so a chunk shorter than three bytes
      // (all carry, no output) would otherwise stall the stream for good.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          controller.enqueue(encoder.encode(`${base64Of(carry, true).text}"}`));
          controller.close();
          return;
        }
        cap.bytes += value.byteLength;
        if (cap.bytes > opts.max) {
          cap.exceeded = true;
          await reader.cancel().catch(() => {});
          controller.error(new Error("too_large"));
          return;
        }
        const joined = new Uint8Array(carry.length + value.byteLength);
        joined.set(carry, 0);
        joined.set(value, carry.length);
        const { text, rest } = base64Of(joined, false);
        carry = rest;
        if (text) {
          controller.enqueue(encoder.encode(text));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream, cap };
}

/** A `Content-Disposition: attachment` value that survives any file name:
 *  an ASCII fallback plus the RFC 5987 UTF-8 form. */
export function attachmentDisposition(filename: string): string {
  const safe = filename.replace(/[\r\n"]/g, "_") || "download";
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

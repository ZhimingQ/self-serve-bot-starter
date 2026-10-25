/**
 * The customer's view of their own assistant (the "My assistant" page and the
 * Usage card), built from the platform's GET /v1/instances/{id}/info.
 *
 * Pure, so the mapping is testable without the platform. Only the fields listed
 * here ever reach the browser: unknown fields are dropped, and the model name is
 * reduced to its own name with any platform or provider prefix removed, the
 * same white-label rule as lib/botLogs.ts.
 */

export type BotState = "running" | "starting" | "stopped" | "sleeping" | "error" | "unknown";

export interface BotView {
  state: BotState;
  /** The name the customer gave their assistant, if any. */
  assistantName: string | null;
  size: "lite" | "pro" | null;
  cpu: number | null;
  memoryBytes: number | null;
  diskLimitBytes: number | null;
  diskUsedBytes: number | null;
  version: string | null;
  /** When the running assistant last came online (RFC 3339). */
  startedAt: string | null;
  /** The chat model's own name, e.g. "minimax-m3.1-flash". */
  model: string | null;
  createdAt: string | null;
}

/** Platform statuses → the few states a customer needs to tell apart. */
export function botState(status: unknown): BotState {
  switch (status) {
    case "running":
      return "running";
    case "starting":
    case "creating":
    case "provisioning":
    case "restarting":
      return "starting";
    case "stopped":
    case "terminated":
      return "stopped";
    case "sleeping":
      return "sleeping";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

const BRAND = /openclaw|open-?router|opencode|\bocl\b/i;

/** "opencode-go/minimax-m3.1-flash" → "minimax-m3.1-flash". Null for anything
 *  that is not a plain model name or that still names the platform/provider. */
export function modelLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().split("/").pop()?.trim() ?? "";
  if (!name || name.length > 80 || !/^[A-Za-z0-9][\w.:+-]*$/.test(name) || BRAND.test(name)) return null;
  return name;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const iso = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

export function toBotView(data: unknown): BotView {
  const d = (data ?? {}) as Record<string, unknown>;
  const version = typeof d.version === "string" && /^\d+(?:\.\d+){1,3}$/.test(d.version) ? d.version : null;
  const name = typeof d.assistant_name === "string" ? d.assistant_name.trim().slice(0, 60) : "";
  return {
    state: botState(d.status),
    assistantName: name || null,
    size: d.size === "pro" || d.size === "lite" ? d.size : null,
    cpu: num(d.cpu),
    memoryBytes: num(d.memory_bytes),
    diskLimitBytes: num(d.disk_limit_bytes),
    diskUsedBytes: num(d.disk_used_bytes),
    version,
    startedAt: iso(d.started_at),
    model: modelLabel(d.model),
    createdAt: iso(d.created_at),
  };
}

/** Bytes as a short size: "740 MB", "1.2 GB", "40 GB". */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  const gb = bytes / 1024 ** 3;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1).replace(/\.0$/, "")} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

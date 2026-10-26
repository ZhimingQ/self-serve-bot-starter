// Plugins tool: shapes the platform's /plugins answers into what the panel
// shows, checking every field. Plugin names, descriptions and docs links come
// from a public third-party catalog, so text is length-clipped, passed through
// the caller's scrubber (the handler uses the log scrubber, which removes the
// platform's and providers' names) and only https links pass.

export interface PluginCard {
  name: string;
  title: string;
  description: string;
  category: string;
  official: boolean;
  /** Keys the customer types into the install form (never platform-managed ones). */
  envFields: string[];
  installable: boolean;
  /** Why not, when not installable: "needs_update", "not_on_server" or "not_offered". */
  reason: string | null;
  docsUrl: string | null;
}

export interface InstalledPlugin {
  name: string;
  enabled: boolean;
}

export interface PluginJob {
  id: string;
  action: "install" | "remove";
  plugin: string;
  phase: "installing" | "removing" | "restarting" | "done" | "failed";
  restartSlow: boolean;
}

/** Catalog text names the agent framework and the platform; a white-label
 *  storefront says "assistant" instead. Applied on top of the caller's scrubber. */
export function scrubPluginText(text: string): string {
  return text
    .replace(/\b(?:hermes|openclaw)(?:[\s-]+agent)?(?:'s)?\b/gi, "assistant")
    .replace(/\bnous(?:\s+research)?\b/gi, "the publisher");
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
// The platform's own rule for a value it will write: printable, no spaces,
// quotes, backslashes or $ (it refuses anything else).
const ENV_VALUE_RE = /^[\x21-\x7e]{1,4096}$/;
const PHASES = new Set(["installing", "removing", "restarting", "done", "failed"]);
const REASONS = new Set(["needs_update", "not_on_server", "not_offered"]);

export function isPluginName(v: unknown): v is string {
  return typeof v === "string" && NAME_RE.test(v) && !v.includes("..");
}

function text(v: unknown, max: number, scrub: (s: string) => string): string {
  if (typeof v !== "string") return "";
  const clean = scrubPluginText(scrub(v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()));
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// A docs link that names the platform, the agent framework or a provider (in
// its host, path or encoded form) would undo the scrubbed text, so it is dropped.
const BRANDED_URL = /openclaw|open-?router|opencode|hermes|nous/i;

function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  try {
    const url = new URL(v);
    if (url.protocol !== "https:") return null;
    let decoded = url.href;
    try {
      decoded = decodeURIComponent(url.href);
    } catch {
      // Malformed escapes: judge the raw form only.
    }
    return BRANDED_URL.test(url.href) || BRANDED_URL.test(decoded) ? null : url.href;
  } catch {
    return null;
  }
}

export function toPluginCatalog(raw: unknown, scrub: (s: string) => string = (s) => s): PluginCard[] {
  if (!Array.isArray(raw)) return [];
  const out: PluginCard[] = [];
  for (const item of raw.slice(0, 2000)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (!isPluginName(e.name)) continue;
    const envFields = Array.isArray(e.env_fields)
      ? e.env_fields.filter((k): k is string => typeof k === "string" && ENV_KEY_RE.test(k)).slice(0, 20)
      : [];
    const reason = typeof e.reason === "string" && REASONS.has(e.reason) ? e.reason : null;
    out.push({
      name: e.name,
      title: text(e.title, 80, scrub) || text(e.name, 80, scrub),
      description: text(e.description, 400, scrub),
      category: text(e.category, 40, scrub),
      official: e.tier === "official",
      envFields,
      installable: e.installable === true,
      reason: e.installable === true ? null : reason ?? "not_offered",
      docsUrl: httpsUrl(e.docs_url),
    });
  }
  return out;
}

export function toInstalledPlugins(raw: unknown): InstalledPlugin[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && isPluginName((p as Record<string, unknown>).name))
    .map((p) => ({ name: p.name as string, enabled: p.enabled !== false }));
}

/** The job, minus its raw error text (installer output can carry paths and
 *  internals); the panel explains a failure in its own words. */
export function toPluginJob(raw: unknown): PluginJob | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  if (typeof j.id !== "string" || !isPluginName(j.plugin) || typeof j.phase !== "string" || !PHASES.has(j.phase)) return null;
  if (j.action !== "install" && j.action !== "remove") return null;
  return {
    id: j.id.slice(0, 64),
    action: j.action,
    plugin: j.plugin,
    phase: j.phase as PluginJob["phase"],
    restartSlow: j.restart_slow === true,
  };
}

/** The install form's values: string keys and values in the platform's shape
 *  only. Returns null when anything does not fit, so nothing half-valid is sent. */
export function cleanPluginEnv(raw: unknown): Record<string, string> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 20) return null;
  for (const [key, value] of entries) {
    if (!ENV_KEY_RE.test(key) || typeof value !== "string") return null;
    const v = value.trim();
    if (!v) continue;
    if (!ENV_VALUE_RE.test(v) || /['\\$]/.test(v)) return null;
    out[key] = v;
  }
  return out;
}

/** Every catalog card plus a removable card for each installed plugin the
 *  catalog no longer lists, so nothing installed is ever stuck on the bot. */
export function withInstalledCards(catalog: PluginCard[], installed: InstalledPlugin[]): PluginCard[] {
  const known = new Set(catalog.map((c) => c.name));
  const extra = installed
    .filter((p) => !known.has(p.name))
    .map((p): PluginCard => ({
      name: p.name,
      title: scrubPluginText(p.name),
      description: "",
      category: "",
      official: false,
      envFields: [],
      installable: false,
      reason: "not_offered",
      docsUrl: null,
    }));
  return extra.length ? [...catalog, ...extra] : catalog;
}

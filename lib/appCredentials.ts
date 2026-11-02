/**
 * Apps that connect with the customer's own API key or login details rather
 * than a sign-in page. These helpers sit between the browser and the platform:
 * the values pass through once and are never stored, logged or sent back.
 */

export const MAX_CREDENTIAL_CHARS = 16_384;
const MAX_CREDENTIAL_FIELDS = 32;
const FIELD_NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const SCHEME_RE = /^[A-Z0-9_]{1,32}$/;

export interface AppAuthField {
  name: string;
  label: string;
  description: string;
  required: boolean;
  secret: boolean;
  default: string | null;
}

export interface AppAuth {
  scheme: string;
  schemes: string[];
  fields: AppAuthField[];
  guideUrl: string | null;
}

export function validScheme(value: unknown): value is string {
  return typeof value === "string" && SCHEME_RE.test(value);
}

/** A flat `{ field: value }` of strings within bounds, or null to refuse it. */
export function readCredentials(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_CREDENTIAL_FIELDS) return null;
  const out: Record<string, string> = {};
  for (const [name, raw] of entries) {
    if (!FIELD_NAME_RE.test(name) || typeof raw !== "string" || raw.length > MAX_CREDENTIAL_CHARS) return null;
    out[name] = raw;
  }
  return out;
}

/** The form description from the platform's answer, or from this storefront's
 *  own route repeating it (`guideUrl`), keeping only what the panel draws. Null
 *  when the answer does not describe a credential app. */
export function readAppAuth(value: unknown): AppAuth | null {
  const data = (value ?? {}) as Record<string, unknown>;
  if (data.connect !== undefined && data.connect !== "credentials") return null;
  if (!validScheme(data.scheme) || !Array.isArray(data.fields)) return null;
  const fields: AppAuthField[] = [];
  for (const entry of data.fields) {
    const f = (entry ?? {}) as Record<string, unknown>;
    if (typeof f.name !== "string" || !FIELD_NAME_RE.test(f.name)) continue;
    fields.push({
      name: f.name,
      label: typeof f.label === "string" && f.label ? f.label : f.name,
      description: typeof f.description === "string" ? f.description : "",
      required: f.required === true,
      secret: f.secret !== false,
      default: typeof f.default === "string" ? f.default : null,
    });
  }
  if (fields.length === 0) return null;
  const guideUrl = data.guide_url ?? data.guideUrl;
  const guide = typeof guideUrl === "string" && /^https?:\/\//.test(guideUrl) ? guideUrl : null;
  const schemes = Array.isArray(data.schemes) ? data.schemes.filter(validScheme) : [];
  return { scheme: data.scheme, schemes: schemes.length > 0 ? schemes : [data.scheme], fields, guideUrl: guide };
}

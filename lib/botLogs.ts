// The assistant's recent log lines, as the Logs tab shows them.
//
// The platform (GET /v1/instances/{id}/logs) already masks secrets, IP
// addresses and its own hosts and paths. What it leaves on purpose is names:
// its own brand and the upstream AI providers, which only the storefront can
// replace, because only the storefront knows it is white-label. This file does
// that, and re-checks the shape of every line before it reaches the browser.

export interface LogLine {
  /** ISO timestamp from the container, or null when the line had none. */
  time: string | null;
  stream: "stdout" | "stderr";
  text: string;
}

export const LOG_TAIL_CHOICES = [100, 200, 500] as const;
export const LOG_TAIL_DEFAULT = 200;
const MAX_LINES = 500;
const MAX_TEXT = 2000;

// Any mention of the platform or an upstream provider, in prose, a domain, an
// identifier (OPENROUTER_API_KEY, OpenRouterError) or percent-encoded. No word
// boundaries on purpose: `_` and a following capital are where they hide.
const BRAND_ANY = /openclaw[\s_-]*launch|open-?router|opencode/i;
// The text is read one whitespace-free token at a time and every pattern below
// is anchored so it cannot restart inside a run it already scanned: a hostile
// 2000-character line costs linear time.
const URL_RE = /https?:\/\/[^\s"'<>]*/gi;
const DOMAIN_RE = /(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]{1,63}\.){0,8}(?:openclaw-?launch\.(?:com|app)|open-?router\.ai|opencode\.ai)(?![A-Za-z0-9-])/gi;
const NAME_RULES: { re: RegExp; word: string; phrase: string }[] = [
  { re: /openclaw[\s_-]{0,200}launch/gi, word: "service", phrase: "the service" },
  { re: /open-?router/gi, word: "provider", phrase: "the AI provider" },
  // "go" only as part of the name: "OpenCode got a 429" keeps its "got".
  { re: /opencode(?:[-_]?go(?![a-z]))?/gi, word: "provider", phrase: "the AI provider" },
];

/** Decodes %XX escapes of ASCII only, one by one: a malformed escape elsewhere
 *  in the token cannot make the whole decode fail and hide a name. */
function asciiDecode(token: string): string {
  return token.replace(/%([0-7][0-9A-Fa-f])/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

const IDENT = /[A-Za-z0-9_]/;

function scrubNames(text: string): string {
  let out = text.replace(DOMAIN_RE, (m) => (/openclaw/i.test(m) ? "the service" : "the AI provider"));
  for (const { re, word, phrase } of NAME_RULES) {
    out = out.replace(re, (m: string, offset: number, all: string) => {
      const inIdentifier = IDENT.test(all[offset - 1] ?? "") || IDENT.test(all[offset + m.length] ?? "");
      if (!inIdentifier) return phrase;
      return m === m.toUpperCase() ? word.toUpperCase() : word;
    });
  }
  return out;
}

/** Replaces the platform's brand and the upstream providers' names. */
export function scrubLogText(text: string): string {
  // 1. A link that names one of them anywhere (host, path, query, encoded) goes whole.
  let out = text.replace(URL_RE, (url) => (BRAND_ANY.test(url) || BRAND_ANY.test(asciiDecode(url)) ? "[link]" : url));
  // 2. Names in prose, domains and identifiers (two-word names span a space).
  if (BRAND_ANY.test(out)) out = scrubNames(out);
  // 3. Names hidden behind percent-escapes outside a full URL.
  if (out.includes("%")) {
    out = out.replace(/\S+/g, (token) => {
      if (!token.includes("%")) return token;
      const plain = asciiDecode(token);
      return BRAND_ANY.test(plain) ? scrubNames(plain) : token;
    });
  }
  return out;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** The platform's `lines`, checked field by field, scrubbed and clipped. */
export function toLogLines(raw: unknown): LogLine[] {
  if (!Array.isArray(raw)) return [];
  const out: LogLine[] = [];
  for (const item of raw.slice(-MAX_LINES)) {
    if (!item || typeof item !== "object") continue;
    const { time, stream, text } = item as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) continue;
    const clean = scrubLogText(text);
    out.push({
      time: typeof time === "string" && ISO_TIME.test(time) ? time : null,
      stream: stream === "stderr" ? "stderr" : "stdout",
      text: clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean,
    });
  }
  return out;
}

/** `?tail=` from the browser: one of the offered choices, else the default. */
export function parseLogTail(raw: string | null): number {
  const n = Number(raw);
  return (LOG_TAIL_CHOICES as readonly number[]).includes(n) ? n : LOG_TAIL_DEFAULT;
}

/**
 * Name matching for the app catalog (lib/appCatalog.json rows).
 *
 * Used by the Apps panel search and by the Plugins section, which points a
 * customer who searched plugins for an app ("gmail", "click up") at the Apps
 * panel, but only when the search really names an app. Matching ignores case,
 * spaces and punctuation, so "Click Up", "click-up" and "clickup" are equal.
 */

export type CatalogRow = [slug: string, name: string];

export const MIN_APP_QUERY = 3;

/** Catalog rows that would name the platform underneath (white-label). */
export const BRANDED_APP = /composio|openclaw/i;

export function compactAppText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** True when the row's name or slug contains the query. */
export function appMatchesQuery([slug, name]: CatalogRow, query: string): boolean {
  const raw = query.trim().toLowerCase();
  if (!raw) return true;
  // The Apps panel's original literal match, for every query length.
  if (name.toLowerCase().includes(raw) || slug.replace(/_/g, " ").includes(raw)) return true;
  // Spaces and punctuation ignored only from three letters: shorter compact
  // strings ("db") land inside unrelated names ("weights_and_biases"), and
  // "+++" compacts to nothing.
  const q = compactAppText(raw);
  return q.length >= MIN_APP_QUERY && (compactAppText(name).includes(q) || compactAppText(slug).includes(q));
}

/** Up to `max` rows naming the query: exact first, then prefix, then contains,
 *  otherwise in catalog order (popular first). Empty below MIN_APP_QUERY. */
export function matchCatalogApps(rows: CatalogRow[], query: string, max = 3): CatalogRow[] {
  const q = compactAppText(query);
  if (q.length < MIN_APP_QUERY) return [];
  const rank = ([slug, name]: CatalogRow): number => {
    const n = compactAppText(name);
    const s = compactAppText(slug);
    if (n === q || s === q) return 0;
    if (n.startsWith(q) || s.startsWith(q)) return 1;
    if (n.includes(q) || s.includes(q)) return 2;
    return -1;
  };
  // Named exactly: drop apps that only contain the search mid-name
  // ("gmail" offers Gmail, not Bigmailer).
  const ranked = rows.map((row, i) => ({ row, i, r: rank(row) })).filter((x) => x.r >= 0);
  const worst = ranked.some((x) => x.r === 0) ? 1 : 2;
  return ranked
    .filter((x) => x.r <= worst)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, max)
    .map((x) => x.row);
}

/** The apps the Plugins section may name, from the catalog and the /api/apps
 *  answer. Fails closed: outside the public preview it names nothing unless
 *  the server answered and said Apps are on, and it keeps to the server's
 *  managedApps list when there is one (the Apps panel's own rule). */
export function suggestableApps(
  catalog: { s: string; n: string }[],
  apps: { enabled?: unknown; managedApps?: unknown; connections?: unknown } | null,
  preview: boolean,
): { rows: CatalogRow[]; connected: Set<string> } {
  if (!preview && (!apps || apps.enabled !== true)) return { rows: [], connected: new Set() };
  const managed = new Set<string>(Array.isArray(apps?.managedApps) ? (apps!.managedApps as string[]) : []);
  const rows: CatalogRow[] = catalog
    .filter((a) => !BRANDED_APP.test(a.s) && !BRANDED_APP.test(a.n) && (managed.size === 0 || managed.has(a.s)))
    .map((a) => [a.s, a.n]);
  const connections = Array.isArray(apps?.connections) ? (apps!.connections as { app?: unknown; status?: unknown }[]) : [];
  const connected = new Set(connections.filter((c) => c?.status === "active" && typeof c.app === "string").map((c) => c.app as string));
  return { rows, connected };
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Messages } from "../../lib/i18n";
import AppLogo from "./AppLogo";
import AppCredentialForm from "./AppCredentialForm";
import { BRANDED_APP, appMatchesQuery } from "../../lib/appMatch";

/**
 * "Apps" — connect the customer's own Gmail, Calendar, Notion and the rest so
 * the assistant can work in them.
 *
 * The list is lib/appCatalog.json (popular first, then A to Z), loaded only when
 * this panel opens so the rest of /app does not carry it. The server says which
 * of those can be connected with a sign-in link (managedApps) and which with the
 * customer's own API key or login details (credentialApps); when it cannot say,
 * every app is offered and the server refuses the ones it must.
 *
 * A credential app opens AppCredentialForm here. A sign-in app opens the app's
 * own sign-in page in a new tab. The tab is opened
 * synchronously on the click (before the request) so pop-up blockers allow it,
 * then pointed at the URL once the server answers. Coming back to this tab
 * refreshes the list, which is when a finished sign-in shows up as connected.
 */

type Row = [slug: string, name: string];
interface Connection { id: string; app: string; status: string }
interface State { enabled: boolean; connections: Connection[]; managedApps: string[]; credentialApps: string[] }

const PAGE = 48;
const BRANDED = BRANDED_APP;
const PREVIEW: State = {
  enabled: true,
  connections: [{ id: "preview-gmail", app: "gmail", status: "active" }],
  managedApps: [],
  credentialApps: [],
};

/** `manageOnly`: list and disconnect only (a paused customer taking back access);
 *  no catalog, no connect or reconnect. */
/** `initialQuery`: opens already searched (the Plugins section sends app searches here). */
export default function AppsPanel({ copy, preview, brandName, manageOnly = false, initialQuery = "" }: { copy: Messages; preview: boolean; brandName: string; manageOnly?: boolean; initialQuery?: string }) {
  const t = copy.apps;
  const [catalog, setCatalog] = useState<Row[] | null>(null);
  const [state, setState] = useState<State | null>(preview ? PREVIEW : null);
  const [load, setLoad] = useState<"loading" | "ready" | "error">(preview ? "ready" : "loading");
  const [query, setQuery] = useState(initialQuery);
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "note"; text: string; link?: string } | null>(null);
  const [credentialApp, setCredentialApp] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // The catalog also names connected apps, so it loads in manage-only mode too.
    import("../../lib/appCatalog.json").then((m) => {
      const apps = (m.default as { apps: { s: string; n: string }[] }).apps;
      if (live) setCatalog(apps.filter((a) => !BRANDED.test(a.s) && !BRANDED.test(a.n)).map((a) => [a.s, a.n]));
    }).catch(() => { if (live) setCatalog([]); });
    return () => { live = false; };
  }, []);

  // Every list request and every mutation takes a ticket; a list answer is used
  // only if nothing newer started meanwhile, so a refresh that began before a
  // disconnect can never bring the removed app back on screen.
  const seq = useRef(0);
  const inFlight = useRef(false);
  // A refresh asked for while one is out (focus + visibilitychange fire
  // together; or the customer returns from a sign-in mid-request) is queued,
  // not dropped, so the newest state is always read once more at the end.
  const again = useRef(false);
  const deleting = useRef(false);
  const refresh = useCallback(async function run(silent = false): Promise<void> {
    if (preview) return;
    if (silent && (inFlight.current || deleting.current)) { again.current = true; return; }
    const ticket = ++seq.current;
    inFlight.current = true;
    if (!silent) setLoad("loading");
    try {
      const res = await fetch("/api/apps", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (ticket !== seq.current) return;
      if (!res.ok) throw new Error(String(data.error ?? res.status));
      setState({
        enabled: data.enabled === true,
        connections: Array.isArray(data.connections) ? data.connections : [],
        managedApps: Array.isArray(data.managedApps) ? data.managedApps : [],
        credentialApps: Array.isArray(data.credentialApps) ? data.credentialApps : [],
      });
      setLoad("ready");
    } catch {
      if (!silent && ticket === seq.current) setLoad("error");
    } finally {
      if (ticket === seq.current) {
        inFlight.current = false;
        if (again.current) { again.current = false; void run(true); }
      }
    }
  }, [preview]);

  useEffect(() => { void refresh(); }, [refresh]);
  // A sign-in finishes in another tab; coming back is the moment to look again.
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(true); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [refresh]);

  const names = useMemo(() => new Map((catalog ?? []).map(([s, n]) => [s, n])), [catalog]);
  const nameOf = (slug: string) =>
    names.get(slug) ?? (BRANDED.test(slug) ? t.otherApp : slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));

  const credentialSlugs = useMemo(() => new Set(state?.credentialApps ?? []), [state?.credentialApps]);
  const offered = useMemo(() => {
    const connectable = new Set([...(state?.managedApps ?? []), ...credentialSlugs]);
    return (catalog ?? []).filter(([s]) => connectable.size === 0 || connectable.has(s));
  }, [catalog, state?.managedApps, credentialSlugs]);
  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? offered.filter((row) => appMatchesQuery(row, q)) : offered),
    [offered, q],
  );
  const connectedSlugs = new Set((state?.connections ?? []).filter((c) => c.status === "active").map((c) => c.app));

  function errorText(code: unknown): string {
    const errors = t.errors as Record<string, string>;
    return typeof code === "string" && errors[code] ? errors[code] : t.errors.generic;
  }

  async function connect(slug: string) {
    setMessage(null);
    if (preview) { setMessage({ kind: "note", text: t.previewNote }); return; }
    if (credentialSlugs.has(slug)) { setCredentialApp(slug); return; }
    // Opened now, inside the click, so a pop-up blocker lets it through.
    const tab = window.open("about:blank", "_blank");
    setBusy(slug);
    try {
      const res = await fetch("/api/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: slug }),
      });
      const data = await res.json().catch(() => ({}));
      // The list was unavailable, so the app was offered without knowing how it connects.
      if (data.needsCredentials === true) {
        tab?.close();
        setCredentialApp(slug);
        return;
      }
      if (!res.ok || typeof data.redirectUrl !== "string") {
        tab?.close();
        setMessage({ kind: "error", text: errorText(data.error) });
        return;
      }
      const notice = ` ${t.heldNote(brandName)}`;
      if (tab && !tab.closed) {
        tab.opener = null;
        tab.location.href = data.redirectUrl;
        setMessage({ kind: "note", text: `${t.openedNote}${notice}` });
      } else {
        setMessage({ kind: "note", text: `${t.blockedNote}${notice}`, link: data.redirectUrl });
      }
    } catch {
      tab?.close();
      setMessage({ kind: "error", text: t.errors.generic });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(c: Connection) {
    setMessage(null);
    if (preview) { setMessage({ kind: "note", text: t.previewNote }); return; }
    setBusy(c.id);
    // No list answer started before or during the delete may land after it.
    deleting.current = true;
    seq.current++;
    inFlight.current = false;
    let removed = false;
    try {
      const res = await fetch(`/api/apps?id=${encodeURIComponent(c.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ kind: "error", text: errorText(data.error) }); return; }
      removed = true;
      setState((s) => (s ? { ...s, connections: s.connections.filter((x) => x.id !== c.id) } : s));
      setMessage({ kind: "note", text: t.disconnectedNote(nameOf(c.app)) });
    } catch {
      setMessage({ kind: "error", text: t.errors.generic });
    } finally {
      seq.current++;
      inFlight.current = false;
      deleting.current = false;
      setBusy(null);
      // One fresh read after the delete settled (and any queued refresh).
      if (removed || again.current) { again.current = false; void refresh(true); }
    }
  }

  const statusText = (status: string) =>
    status === "active" ? t.statusConnected : status === "initiated" ? t.statusPending : t.statusReconnect;

  function credentialConnected() {
    const slug = credentialApp;
    setCredentialApp(null);
    if (slug) setMessage({ kind: "note", text: t.credentialConnected(nameOf(slug)) });
    void refresh(true);
  }

  return (
    <div className="control-content apps-panel">
      <section className="control-heading">
        <span>{t.kicker}</span>
        <h1>{t.title}</h1>
        <p>{t.body}</p>
      </section>

      {load === "loading" && (
        <div className="settings-state" role="status"><span className="mini-spinner" aria-hidden="true" />{t.loading}</div>
      )}
      {load === "error" && (
        <div className="settings-state panel-error" role="alert">
          <span>{t.loadError}</span>
          <button type="button" onClick={() => void refresh()}>{copy.tryAgain}</button>
        </div>
      )}
      {load === "ready" && state && !state.enabled && <p className="byok-note">{t.notEnabled}</p>}

      {load === "ready" && state?.enabled && (
        <>
          {message && (
            <p className={message.kind === "error" ? "panel-error apps-message" : "byok-note apps-message"} role={message.kind === "error" ? "alert" : "status"}>
              {message.text}
              {message.link && <> <a href={message.link} target="_blank" rel="noopener noreferrer">{t.openLink} <span aria-hidden="true">↗</span></a></>}
            </p>
          )}

          <section className="apps-connected" aria-labelledby="apps-connected-title">
            <h2 id="apps-connected-title">{t.connectedTitle}</h2>
            {state.connections.length === 0 ? (
              <p className="byok-note">{t.noneConnected}</p>
            ) : (
              <ul>
                {state.connections.map((c) => (
                  <li key={c.id}>
                    <AppLogo slug={BRANDED.test(c.app) ? "unknown-app" : c.app} name={nameOf(c.app)} size={24} lazy={false} />
                    <span className="apps-name">
                      <strong>{nameOf(c.app)}</strong>
                      <small className={c.status === "active" ? "is-ok" : "is-pending"}>{statusText(c.status)}</small>
                    </span>
                    {!manageOnly && c.status !== "active" && c.status !== "initiated" && (
                      <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void connect(c.app)}>
                        {t.reconnect}
                      </button>
                    )}
                    <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void disconnect(c)}>
                      {busy === c.id ? t.disconnecting : t.disconnect}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!manageOnly && <p className="apps-hint">{t.askHint}</p>}
          </section>

          {!manageOnly && <section className="apps-browse" aria-labelledby="apps-browse-title">
            <h2 id="apps-browse-title">{t.browseTitle}</h2>
            <label className="apps-search">
              <span className="sr-only">{t.searchLabel}</span>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
                placeholder={t.searchPlaceholder}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {catalog === null ? (
              <div className="settings-state" role="status"><span className="mini-spinner" aria-hidden="true" />{t.loading}</div>
            ) : matches.length === 0 ? (
              <p className="byok-note" role="status">{t.noMatch}</p>
            ) : (
              <>
                <ul className="apps-grid">
                  {matches.slice(0, shown).map(([slug, name]) => {
                    const isOn = connectedSlugs.has(slug);
                    return (
                      <li key={slug}>
                        <AppLogo slug={slug} name={name} size={22} />
                        <strong>{name}</strong>
                        {isOn ? (
                          <span className="apps-on">{t.statusConnected}</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy !== null}
                            aria-label={t.connectLabel(name)}
                            onClick={() => void connect(slug)}
                          >
                            {busy === slug ? t.connecting : t.connect}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {matches.length > shown && (
                  <button type="button" className="btn btn-secondary apps-more" onClick={() => setShown((n) => n + PAGE)}>
                    {t.showMore}
                  </button>
                )}
              </>
            )}
          </section>}

          {credentialApp && (
            <AppCredentialForm
              copy={copy}
              brandName={brandName}
              slug={credentialApp}
              name={nameOf(credentialApp)}
              onClose={() => setCredentialApp(null)}
              onConnected={credentialConnected}
            />
          )}
        </>
      )}
    </div>
  );
}

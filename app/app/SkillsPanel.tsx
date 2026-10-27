"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Messages } from "../../lib/i18n";
import type { Locale } from "../../lib/i18n";

/**
 * "Skills" — ready-made know-how the customer can switch on for their
 * assistant: weekly reports, proposals, invoices, SEO check-ups and so on.
 *
 * The list is lib/skillCatalog.json, the vetted business skills (no API key
 * needed, runs on the assistant as shipped), with our own name and one-line
 * description in every language. Loaded only when this panel opens; the grid
 * shows the first FIRST cards until "Show all", or every match while filtering.
 *
 * Adding writes the skill into the assistant, which takes a few seconds; the
 * assistant picks it up in open chats too. The server only accepts slugs from
 * that same list, so this page can never add or remove anything else.
 */

interface Entry { s: string; g: string; t: Record<string, [string, string]> }
interface Catalog { groups: string[]; skills: Entry[] }
interface State { installed: string[]; others: number }

/** The add/remove still on its way, kept outside the component: leaving the
 *  panel unmounts it mid-request, and a reopened panel must read the list only
 *  after that change has landed, or it shows the state from before it. */
let pendingChange: Promise<unknown> | null = null;

const FIRST = 60;

const PREVIEW: State = { installed: ["weekly-report-generator", "invoice-generator"], others: 0 };

export default function SkillsPanel({ copy, preview, locale }: { copy: Messages; preview: boolean; locale: Locale }) {
  const t = copy.skills;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [state, setState] = useState<State | null>(preview ? PREVIEW : null);
  const [load, setLoad] = useState<"loading" | "ready" | "error" | "asleep">(preview ? "ready" : "loading");
  const [group, setGroup] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  // "Show all" removes its own button, so focus moves to the first card it revealed.
  const firstRevealed = useRef<HTMLLIElement>(null);
  const [focusRevealed, setFocusRevealed] = useState(false);
  useEffect(() => {
    if (!focusRevealed) return;
    firstRevealed.current?.focus();
    setFocusRevealed(false);
  }, [focusRevealed]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "note"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    import("../../lib/skillCatalog.json")
      .then((m) => { if (live) setCatalog(m.default as unknown as Catalog); })
      .catch(() => { if (live) setCatalog({ groups: [], skills: [] }); });
    return () => { live = false; };
  }, []);

  // A list answer is used only if no change started after it was asked for,
  // so a slow read can never undo an add or remove already on screen.
  const seq = useRef(0);
  const refresh = useCallback(async (silent = false) => {
    if (preview) return;
    const ticket = ++seq.current;
    if (!silent) setLoad("loading");
    try {
      if (pendingChange) await pendingChange.catch(() => {});
      if (ticket !== seq.current) return;
      const res = await fetch("/api/skills", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (ticket !== seq.current) return;
      if (res.status === 409 && data.error === "not_running") { setLoad("asleep"); return; }
      if (!res.ok) throw new Error(String(data.error ?? res.status));
      setState({
        installed: Array.isArray(data.installed) ? data.installed.filter((s: unknown) => typeof s === "string") : [],
        others: typeof data.others === "number" ? data.others : 0,
      });
      setLoad("ready");
    } catch {
      if (!silent && ticket === seq.current) setLoad("error");
    }
  }, [preview]);

  useEffect(() => { void refresh(); }, [refresh]);

  // A change that finishes after this panel was left must not read the list for
  // it: the reopened panel already reads once that change has landed.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const text = (e: Entry): [string, string] => e.t[locale] ?? e.t.en;
  const byslug = useMemo(() => new Map((catalog?.skills ?? []).map((e) => [e.s, e])), [catalog]);
  const nameOf = (slug: string) => { const e = byslug.get(slug); return e ? text(e)[0] : slug; };
  const installed = new Set(state?.installed ?? []);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (catalog?.skills ?? []).filter((e) => {
    if (group !== "all" && e.g !== group) return false;
    if (!q) return true;
    const [name, blurb] = e.t[locale] ?? e.t.en;
    return `${name} ${blurb} ${e.t.en[0]}`.toLowerCase().includes(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [catalog, group, q, locale]);

  const filtering = group !== "all" || q !== "";
  const visible = filtering || all ? shown : shown.slice(0, FIRST);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of catalog?.skills ?? []) m[e.g] = (m[e.g] ?? 0) + 1;
    return m;
  }, [catalog]);

  function errorText(code: unknown): string {
    const errors = t.errors as Record<string, string>;
    return typeof code === "string" && errors[code] ? errors[code] : t.errors.generic;
  }

  async function change(slug: string, add: boolean) {
    setMessage(null);
    if (preview) { setMessage({ kind: "note", text: t.previewNote }); return; }
    setBusy(slug);
    seq.current++;
    try {
      const request = add
        ? fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skill: slug }) })
        : fetch(`/api/skills?skill=${encodeURIComponent(slug)}`, { method: "DELETE" });
      const settled = request.catch(() => null);
      pendingChange = settled;
      void settled.then(() => { if (pendingChange === settled) pendingChange = null; });
      const res = await request;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Written but the open chats did not refresh: it IS on the assistant.
        if (add && data.error === "refresh_failed") {
          setState((s) => (s ? { ...s, installed: [...new Set([...s.installed, slug])] } : s));
        }
        if (res.status === 409 && data.error === "not_running") setLoad("asleep");
        setMessage({ kind: "error", text: errorText(data.error) });
        return;
      }
      setState((s) => (s ? {
        ...s,
        installed: add ? [...new Set([...s.installed, slug])] : s.installed.filter((x) => x !== slug),
      } : s));
      setMessage({ kind: "note", text: add ? t.addedNote(nameOf(slug)) : t.removedNote(nameOf(slug)) });
    } catch {
      setMessage({ kind: "error", text: t.errors.generic });
    } finally {
      setBusy(null);
      if (mounted.current) void refresh(true);
    }
  }

  const groupLabel = (g: string) => (t.groups as Record<string, string>)[g] ?? g;

  return (
    <div className="control-content apps-panel skills-panel">
      <section className="control-heading">
        <span>{t.kicker}</span>
        <h1>{t.title}</h1>
        <p>{t.body}</p>
      </section>

      {message && (
        <p className={message.kind === "error" ? "panel-error apps-message" : "byok-note apps-message"} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}

      {load === "loading" && (
        <div className="settings-state" role="status"><span className="mini-spinner" aria-hidden="true" />{t.loading}</div>
      )}
      {load === "error" && (
        <div className="settings-state panel-error" role="alert">
          <span>{t.loadError}</span>
          <button type="button" onClick={() => void refresh()}>{copy.tryAgain}</button>
        </div>
      )}
      {load === "asleep" && (
        <div className="settings-state" role="status">
          <span>{t.asleep}</span>
          <button type="button" onClick={() => void refresh()}>{copy.tryAgain}</button>
        </div>
      )}

      {load === "ready" && state && (
        <>
          <section className="apps-connected" aria-labelledby="skills-on-title">
            <h2 id="skills-on-title">{t.installedTitle}</h2>
            {state.installed.length === 0 ? (
              <p className="byok-note">{t.noneInstalled}</p>
            ) : (
              <ul>
                {state.installed.map((slug) => (
                  <li key={slug}>
                    <span className="apps-name">
                      <strong>{nameOf(slug)}</strong>
                      <small className="is-ok">{t.statusOn}</small>
                    </span>
                    <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void change(slug, false)}>
                      {busy === slug ? t.removing : t.remove}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {state.others > 0 && <p className="apps-hint">{t.othersNote(state.others)}</p>}
            <p className="apps-hint">{t.askHint}</p>
          </section>

          <section className="apps-browse" aria-labelledby="skills-browse-title">
            <h2 id="skills-browse-title">{t.browseTitle}</h2>
            <div className="skills-groups" role="group" aria-label={t.groupsLabel}>
              {["all", ...(catalog?.groups ?? [])].map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`skills-chip${group === g ? " is-on" : ""}`}
                  aria-pressed={group === g}
                  onClick={() => setGroup(g)}
                >
                  {g === "all" ? t.groupAll : groupLabel(g)}
                  {g !== "all" && counts[g] ? <span className="skills-chip-count">{counts[g]}</span> : null}
                </button>
              ))}
            </div>
            <label className="apps-search">
              <span className="sr-only">{t.searchLabel}</span>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.searchPlaceholder}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {catalog === null ? (
              <div className="settings-state" role="status"><span className="mini-spinner" aria-hidden="true" />{t.loading}</div>
            ) : shown.length === 0 ? (
              <p className="byok-note" role="status">{t.noMatch}</p>
            ) : (
              <ul className="skills-grid" id="skills-grid">
                {visible.map((e, i) => {
                  const [name, blurb] = text(e);
                  const isOn = installed.has(e.s);
                  return (
                    <li key={e.s} ref={i === FIRST ? firstRevealed : undefined} tabIndex={i === FIRST ? -1 : undefined}>
                      <div>
                        <strong>{name}</strong>
                        <p>{blurb}</p>
                      </div>
                      {isOn ? (
                        <span className="apps-on">{t.statusOn}</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy !== null}
                          aria-label={t.addLabel(name)}
                          onClick={() => void change(e.s, true)}
                        >
                          {busy === e.s ? t.adding : t.add}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {catalog && !filtering && !all && shown.length > FIRST && (
              <button type="button" className="btn btn-secondary skills-all" aria-controls="skills-grid" onClick={() => { setAll(true); setFocusRevealed(true); }}>
                {t.showAll(shown.length)}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}

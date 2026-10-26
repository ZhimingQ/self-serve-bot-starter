"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scrubPluginText, withInstalledCards, type InstalledPlugin, type PluginCard, type PluginJob } from "../../../lib/botPlugins";
import { SectionState, errorText, toolFetch, type SectionProps } from "./shared";

/**
 * Plugins: add-ons from a public plugin catalog for the customer's own
 * assistant. Install and remove run in the background and restart the
 * assistant once; while a job runs the list is polled (without the catalog,
 * which is fetched once) until it is done or failed.
 */

interface PluginsState {
  installed: InstalledPlugin[];
  job: PluginJob | null;
  catalog?: PluginCard[];
}

type Filter = "all" | "installed" | "nokey";

const PAGE = 40;
const POLL_MS = 3000;
// A poll that keeps failing (assistant restarting, network gone) backs off and
// gives up after this many misses in a row, saying so instead of spinning.
const MAX_POLL_MISSES = 20;

const PREVIEW_CATALOG: PluginCard[] = [
  { name: "memory-notes", title: "Memory notes", description: "Keeps short notes about what matters to you between chats.", category: "memory", official: true, envFields: [], installable: true, reason: null, docsUrl: null },
  { name: "weather-tools", title: "Weather", description: "Current weather and forecasts for any city.", category: "tools", official: false, envFields: [], installable: true, reason: null, docsUrl: null },
  { name: "news-digest", title: "News digest", description: "A morning summary of the topics you follow.", category: "tools", official: false, envFields: ["NEWS_API_KEY"], installable: true, reason: null, docsUrl: null },
  { name: "voice-replies", title: "Voice replies", description: "Answers with a spoken reply when you send a voice message.", category: "voice", official: true, envFields: [], installable: true, reason: null, docsUrl: null },
];

const isActive = (job: PluginJob | null | undefined): boolean =>
  !!job && job.phase !== "done" && job.phase !== "failed";

export default function PluginsSection({ copy, preview, status }: SectionProps) {
  const t = copy.botTools.plugins;
  const [catalog, setCatalog] = useState<PluginCard[] | null>(preview ? PREVIEW_CATALOG : null);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [job, setJob] = useState<PluginJob | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "error">(preview ? "ready" : "loading");
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [form, setForm] = useState<PluginCard | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lostContact, setLostContact] = useState(false);
  const missesRef = useRef(0);
  const watchedRef = useRef<string | null>(null);

  const apply = useCallback((data: Partial<PluginsState>) => {
    if (Array.isArray(data.installed)) setInstalled(data.installed);
    if (Array.isArray(data.catalog)) setCatalog(data.catalog);
    setJob(data.job ?? null);
  }, []);

  const refresh = useCallback(async () => {
    if (preview) return;
    setLoad("loading");
    const res = await toolFetch<PluginsState>("plugins", { query: { catalog: "1" } });
    if (res.ok) {
      apply(res.data);
      setLoad("ready");
    } else {
      setLoadError(errorText(copy, res.data.error));
      setLoad("error");
    }
  }, [preview, copy, apply]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while a job runs; report its outcome once.
  useEffect(() => {
    if (preview || !isActive(job)) return;
    watchedRef.current = job?.id ?? null;
    const delay = Math.min(POLL_MS * (1 + missesRef.current), 30_000);
    const timer = window.setTimeout(async () => {
      const res = await toolFetch<PluginsState>("plugins");
      if (!res.ok) {
        missesRef.current += 1;
        if (missesRef.current >= MAX_POLL_MISSES) {
          setLostContact(true);
          setJob(null);
        } else {
          // Keep the job on screen; the effect re-arms on the new object.
          setJob((j) => (j ? { ...j } : j));
        }
        return;
      }
      missesRef.current = 0;
      const next = res.data.job ?? null;
      if (Array.isArray(res.data.installed)) setInstalled(res.data.installed);
      if (!next || next.id !== watchedRef.current) {
        // The watched job is no longer on record (or another took its place):
        // it has ended. The installed list above is current; say it finished.
        if (!next) setNotice(copy.botTools.done);
      } else if (!isActive(next)) {
        const card = catalog?.find((c) => c.name === next.plugin);
        const label = card?.title ?? scrubPluginText(next.plugin);
        if (next.phase === "done") {
          setNotice(next.restartSlow ? t.slowRestart : next.action === "install" ? t.doneInstall(label) : t.doneRemove(label));
        } else {
          setError(errorText(copy, "plugin_failed"));
        }
      }
      setJob(next);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [job, preview, copy, t, catalog]);

  const installedNames = useMemo(() => new Set(installed.map((p) => p.name)), [installed]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return withInstalledCards(catalog ?? [], installed).filter((c) => {
      const has = installedNames.has(c.name);
      // A plugin that is not offered is listed only where it is installed, so it can be removed.
      if (c.reason === "not_offered" && !has) return false;
      if (filter === "installed" && !has) return false;
      if (filter === "nokey" && c.envFields.length > 0) return false;
      return !q || `${c.title} ${c.name} ${c.description} ${c.category}`.toLowerCase().includes(q);
    });
  }, [catalog, installed, query, filter, installedNames]);

  const running = preview || status === "running";
  const busy = submitting || isActive(job);

  function openForm(card: PluginCard) {
    setError("");
    setNotice("");
    setConfirmRemove(null);
    setValues({});
    setForm(card);
  }

  function startedJob(card: PluginCard, action: PluginJob["action"], data: { job?: PluginJob | null }) {
    missesRef.current = 0;
    setLostContact(false);
    setJob(data.job ?? { id: `local-${Date.now()}`, action, plugin: card.name, phase: action === "install" ? "installing" : "removing", restartSlow: false });
  }

  async function install(event: React.FormEvent) {
    event.preventDefault();
    if (!form || busy) return;
    const card = form;
    const env: Record<string, string> = {};
    for (const key of card.envFields) {
      const v = (values[key] ?? "").trim();
      if (!v) { setError(errorText(copy, "missing_env")); return; }
      if (!/^[\x21-\x7e]{1,4096}$/.test(v) || /['\\$]/.test(v)) { setError(errorText(copy, "invalid_env_value")); return; }
      env[key] = v;
    }
    setError("");
    setNotice("");
    if (preview) {
      setInstalled((list) => [...list, { name: card.name, enabled: true }]);
      setForm(null);
      setNotice(t.doneInstall(card.title));
      return;
    }
    setSubmitting(true);
    const res = await toolFetch<{ job: PluginJob }>("plugins", { method: "POST", json: { plugin: card.name, env } });
    setSubmitting(false);
    if (!res.ok) {
      setError(errorText(copy, res.data.error));
      if (res.data.error === "busy" && res.data.job) setJob(res.data.job as PluginJob);
      return;
    }
    setForm(null);
    setValues({});
    startedJob(card, "install", res.data);
  }

  async function remove(card: PluginCard) {
    setConfirmRemove(null);
    if (busy) return;
    setError("");
    setNotice("");
    if (preview) {
      setInstalled((list) => list.filter((p) => p.name !== card.name));
      setNotice(t.doneRemove(card.title));
      return;
    }
    setSubmitting(true);
    const res = await toolFetch<{ job: PluginJob }>("plugins", { method: "DELETE", query: { plugin: card.name } });
    setSubmitting(false);
    if (!res.ok) {
      setError(errorText(copy, res.data.error));
      if (res.data.error === "busy" && res.data.job) setJob(res.data.job as PluginJob);
      return;
    }
    startedJob(card, "remove", res.data);
  }

  const jobLabel = (j: PluginJob) => (j.phase === "restarting" ? t.restarting : j.action === "install" ? t.installing : t.removing);

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
        {load === "ready" && installed.length > 0 && (
          <span className="byok-badge is-own">{installed.length} {t.installed}</span>
        )}
      </header>

      {load === "loading" && <SectionState kind="loading" text={copy.botTools.loading} />}
      {load === "error" && <SectionState kind="error" text={loadError} onRetry={() => void refresh()} retryLabel={copy.tryAgain} />}

      {load === "ready" && (
        <>
          {!running && <p className="byok-note">{copy.botTools.needsRunning}</p>}
          {lostContact && <p className="byok-note" role="status">{t.lostContact}</p>}
          {job && isActive(job) && <SectionState kind="loading" text={`${jobLabel(job)} ${catalog?.find((c) => c.name === job.plugin)?.title ?? scrubPluginText(job.plugin)}`} />}
          {notice && <p className="byok-note" role="status">{notice}</p>}

          <div className="bt-toolbar">
            <input
              className="bt-plugin-search"
              type="search"
              aria-label={t.search}
              placeholder={t.search}
              maxLength={80}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
            />
            {(["all", "installed", "nokey"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={filter === f ? "btn btn-primary" : "btn btn-secondary"}
                aria-pressed={filter === f}
                onClick={() => { setFilter(f); setShown(PAGE); }}
              >
                {f === "all" ? t.filterAll : f === "installed" ? t.filterInstalled : t.filterNoKey}
              </button>
            ))}
          </div>

          {visible.length === 0 && <p className="byok-note">{t.empty}</p>}

          <ul className="bt-connections">
            {visible.slice(0, shown).map((card) => {
              const has = installedNames.has(card.name);
              const working = job && isActive(job) && job.plugin === card.name;
              return (
                <li key={card.name}>
                  <div>
                    <strong>
                      <span className={has ? "bt-dot is-on" : "bt-dot"} aria-hidden="true" />
                      {card.title}
                      {card.official && <small className="bt-plugin-tag">{t.official}</small>}
                    </strong>
                    {card.description && <span>{card.description}</span>}
                    <code>
                      {card.category}
                      {card.category ? " · " : ""}
                      {card.envFields.length > 0 ? t.needsKey : t.noKey}
                      {card.docsUrl && <> · <a href={card.docsUrl} target="_blank" rel="noopener noreferrer">{t.docs} ↗</a></>}
                    </code>
                  </div>
                  <div className="bt-row-actions">
                    {working ? (
                      <span>{jobLabel(job)}</span>
                    ) : has ? (
                      <button type="button" className="btn btn-secondary" disabled={busy || !running} onClick={() => { setForm(null); setConfirmRemove(card.name); }}>
                        {t.remove}
                      </button>
                    ) : card.installable ? (
                      <button type="button" className="btn btn-primary" disabled={busy || !running} onClick={() => openForm(card)}>
                        {t.install}
                      </button>
                    ) : (
                      <span>{card.reason === "needs_update" ? t.needsUpdate : ""}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {visible.length > shown && (
            <div className="byok-actions">
              <button type="button" className="settings-reset" onClick={() => setShown((n) => n + PAGE)}>{t.showMore}</button>
            </div>
          )}

          {confirmRemove && (() => {
            const card = withInstalledCards(catalog ?? [], installed).find((c) => c.name === confirmRemove);
            if (!card) return null;
            return (
              <div className="bt-confirm" role="alertdialog" aria-label={t.remove}>
                <p>{t.confirmRemove(card.title)}</p>
                <div className="byok-actions">
                  <button type="button" className="btn btn-danger" onClick={() => void remove(card)}>{t.remove}</button>
                  <button type="button" className="settings-reset" onClick={() => setConfirmRemove(null)}>{copy.botTools.cancel}</button>
                </div>
              </div>
            );
          })()}

          {form && (
            <form className="bt-keybox" onSubmit={install}>
              <h3 className="bt-subhead">{t.formTitle(form.title)}</h3>
              {form.envFields.length > 0 && <p className="byok-note">{t.formNote}</p>}
              {form.envFields.map((key) => (
                <div className="byok-field" key={key}>
                  <label htmlFor={`bt-plugin-${key}`}>{key}</label>
                  <input
                    id={`bt-plugin-${key}`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={4096}
                    value={values[key] ?? ""}
                    onChange={(e) => { setValues((v) => ({ ...v, [key]: e.target.value })); setError(""); }}
                  />
                </div>
              ))}
              <p className="byok-note">{t.restartNote}</p>
              <div className="byok-actions">
                <button type="submit" className="btn btn-primary" disabled={busy || !running}>
                  {submitting ? copy.botTools.working : t.confirmInstall}
                </button>
                <button type="button" className="settings-reset" onClick={() => setForm(null)}>{copy.botTools.cancel}</button>
              </div>
            </form>
          )}
        </>
      )}

      {error && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}

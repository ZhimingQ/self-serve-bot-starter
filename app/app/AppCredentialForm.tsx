"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Messages } from "../../lib/i18n";
import { readAppAuth, type AppAuth } from "../../lib/appCredentials";

/**
 * The form for an app that connects with the customer's own API key or login
 * details. The values live in this component's state and nowhere else, so
 * closing it forgets them. Whose workspace they land in is said before the
 * customer types anything, not after.
 */
export default function AppCredentialForm({
  copy,
  brandName,
  slug,
  name,
  onClose,
  onConnected,
}: {
  copy: Messages;
  brandName: string;
  slug: string;
  name: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const t = copy.apps;
  const [auth, setAuth] = useState<AppAuth | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The form stays on the answer to the newest request if the customer switches
  // between two kinds of credential while one is loading.
  const ticket = useRef(0);
  const chosen = useRef<string | undefined>(undefined);
  const load = useCallback(async () => {
    const mine = ++ticket.current;
    const scheme = chosen.current;
    setLoadFailed(false);
    try {
      const qs = new URLSearchParams({ app: slug, ...(scheme ? { scheme } : {}) });
      const res = await fetch(`/api/apps?${qs}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (mine !== ticket.current) return;
      const next = res.ok ? readAppAuth(data.auth) : null;
      if (!next) { setLoadFailed(true); return; }
      setAuth(next);
      setValues(Object.fromEntries(next.fields.flatMap((f) => (f.default ? [[f.name, f.default]] : []))));
    } catch {
      if (mine === ticket.current) setLoadFailed(true);
    }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  function chooseScheme(scheme: string) {
    setValues({});
    setError(null);
    setAuth(null);
    chosen.current = scheme;
    void load();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!auth || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: slug, scheme: auth.scheme, credentials: values }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.connected === true) {
        setValues({});
        onConnected();
        return;
      }
      const errors = t.errors as Record<string, string>;
      setError(typeof data.error === "string" && errors[data.error] ? errors[data.error] : t.errors.generic);
    } catch {
      setError(t.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  const schemeNames = t.schemeNames as Record<string, string>;

  return (
    <div className="channel-modal-backdrop" role="dialog" aria-modal="true" aria-label={t.connectLabel(name)}>
      <div className="channel-modal">
        <header>
          <strong>{t.connectLabel(name)}</strong>
          <button type="button" className="channel-modal-close" disabled={busy} onClick={onClose} aria-label={t.credentialCancel}>✕</button>
        </header>
        <div className="channel-modal-body">
          <p>{t.credentialIntro}</p>
          <p>{t.heldNote(brandName)}</p>

          {loadFailed && (
            <div className="settings-state panel-error" role="alert">
              <span>{t.credentialLoadError}</span>
              <button type="button" onClick={() => void load()}>{copy.tryAgain}</button>
            </div>
          )}
          {!loadFailed && !auth && (
            <div className="settings-state" role="status"><span className="mini-spinner" aria-hidden="true" />{t.loading}</div>
          )}

          {auth && (
            <form onSubmit={(e) => void submit(e)} autoComplete="off">
              {auth.schemes.length > 1 && (
                <div className="byok-field">
                  <label htmlFor="app-credential-scheme">{t.credentialScheme}</label>
                  <select disabled={busy} id="app-credential-scheme" value={auth.scheme} onChange={(e) => chooseScheme(e.target.value)}>
                    {auth.schemes.map((s) => <option key={s} value={s}>{schemeNames[s] ?? s}</option>)}
                  </select>
                </div>
              )}
              {auth.fields.map((f, i) => (
                <div className="byok-field" key={f.name}>
                  <label htmlFor={`app-credential-${i}`}>{f.required ? f.label : `${f.label} (${t.credentialOptional})`}</label>
                  <input
                    disabled={busy}
                    id={`app-credential-${i}`}
                    type={f.secret ? "password" : "text"}
                    required={f.required}
                    autoFocus={i === 0}
                    autoComplete={f.secret ? "new-password" : "off"}
                    spellCheck={false}
                    value={values[f.name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                  {f.description && <small>{f.description}</small>}
                </div>
              ))}
              {auth.guideUrl && (
                <p className="byok-note">
                  <a href={auth.guideUrl} target="_blank" rel="noopener noreferrer">{t.credentialGuide} <span aria-hidden="true">↗</span></a>
                </p>
              )}
              {error && <p className="panel-error apps-message" role="alert">{error}</p>}
              <div className="byok-actions">
                <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t.credentialSaving : t.connect}</button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>{t.credentialCancel}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

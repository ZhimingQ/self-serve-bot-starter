"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Messages } from "../../lib/i18n";
import { HERMES_PROVIDERS, MODEL_ID_RE, type HermesProviderId } from "../../lib/hermesProviders";

/**
 * Hermes "use your own AI provider" panel. Shown when the reseller sets
 * ALLOW_END_USER_BYOK=1 on a Hermes storefront. Everything goes through
 * /api/model-key, which resolves the bot from the SESSION; this component never
 * learns an instance id.
 *
 * Unlike the OpenClaw panel this one can switch back: "Use included AI" puts
 * the bot on the model that comes with the plan, so pulling the key never
 * leaves a silent assistant.
 */

interface Status {
  /** Trial or paid plan: the customer may switch keys. False once a trial ends. */
  allowed: boolean;
  trial: boolean;
  hasKey: boolean;
  provider: string | null;
  model: string | null;
  host: string | null;
  keyPreview: string | null;
}

const PREVIEW: Status = { allowed: true, trial: false, hasKey: false, provider: null, model: null, host: null, keyPreview: null };

type ErrorCode = keyof Messages["hkErrors"];

export default function HermesModelKeyPanel({ copy, preview }: { copy: Messages; preview: boolean }) {
  const [status, setStatus] = useState<Status | null>(preview ? PREVIEW : null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(preview ? "ready" : "loading");
  const [provider, setProvider] = useState<HermesProviderId>("openrouter");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<"models" | "save" | "back" | null>(null);
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState<"saved" | "back" | "pending" | "unrecorded" | null>(null);
  // Set once the platform may have changed something we could not confirm: the
  // switch-back button then stays on screen whatever the record says.
  const [uncertain, setUncertain] = useState(false);
  // `busy` is state, so two clicks in one tick both see it unset; this does not.
  const inFlight = useRef(false);
  const [error, setError] = useState<{ code: ErrorCode; message?: string } | null>(null);

  const load = useCallback(async () => {
    if (preview) return;
    // Only the first load shows the spinner: a refresh after a switch keeps the
    // card, and its outcome message, on screen.
    setLoadState((s) => (s === "ready" ? s : "loading"));
    try {
      const res = await fetch("/api/model-key", { cache: "no-store" });
      if (!res.ok) throw new Error("load failed");
      setStatus((await res.json()) as Status);
      setLoadState("ready");
    } catch {
      setLoadState((s) => (s === "ready" ? s : "error"));
    }
  }, [preview]);

  useEffect(() => { void load(); }, [load]);

  const spec = HERMES_PROVIDERS.find((p) => p.id === provider);
  const providerLabel = (id: string | null) =>
    id === "custom" ? copy.hkCustom : HERMES_PROVIDERS.find((p) => p.id === id)?.label ?? id ?? "";

  function fail(code: string | undefined, message?: string) {
    const known = code && code in copy.hkErrors ? (code as ErrorCode) : "generic";
    if (known === "uncertain") setUncertain(true);
    setError({ code: known, message });
  }

  type Outcome = { restartPending?: boolean; recorded?: boolean };
  function settled(body: Outcome, kind: "saved" | "back") {
    if (body.recorded === false) { setUncertain(true); setDone("unrecorded"); return; }
    setUncertain(false);
    setDone(body.restartPending ? "pending" : kind);
  }

  function resetForm() {
    setKey(""); setModel(""); setModels(null); setBaseUrl(""); setError(null);
  }

  async function loadModels() {
    if (!key.trim() || inFlight.current) return;
    inFlight.current = true;
    setBusy("models"); setError(null);
    if (preview) { setModels(["example/model-a", "example/model-b"]); setBusy(null); inFlight.current = false; return; }
    try {
      const res = await fetch("/api/model-key/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelKey: key.trim(), ...(provider === "custom" ? { baseUrl } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { models?: string[]; error?: string; message?: string };
      if (res.ok) setModels(body.models ?? []);
      else fail(res.status === 429 ? "rate_limited" : body.error, body.message);
    } catch {
      fail("generic");
    }
    setBusy(null);
    inFlight.current = false;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !key.trim() || !MODEL_ID_RE.test(model.trim())) return;
    inFlight.current = true;
    setBusy("save"); setError(null); setDone(null);
    if (preview) {
      setStatus({ ...PREVIEW, hasKey: true, provider, model: model.trim(), keyPreview: "sk-pre…view" });
      setBusy(null); setEditing(false); setDone("saved"); resetForm();
      inFlight.current = false;
      return;
    }
    try {
      const res = await fetch("/api/model-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelKey: key.trim(), model: model.trim(), ...(provider === "custom" ? { baseUrl } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as Outcome & { error?: string; message?: string };
      if (res.ok) {
        setEditing(false); settled(body, "saved"); resetForm();
        await load();
      } else {
        fail(res.status === 429 ? "rate_limited" : body.error, body.message);
      }
    } catch {
      // The request may have reached the platform before the connection died.
      fail("uncertain");
    }
    setBusy(null);
    inFlight.current = false;
  }

  async function useIncluded() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("back"); setError(null); setDone(null);
    if (preview) { setStatus(PREVIEW); setBusy(null); setDone("back"); inFlight.current = false; return; }
    try {
      const res = await fetch("/api/model-key", { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as Outcome & { error?: string };
      if (res.ok) { settled(body, "back"); setEditing(false); await load(); }
      else fail(res.status === 429 ? "rate_limited" : body.error);
    } catch {
      fail("uncertain");
    }
    setBusy(null);
    inFlight.current = false;
  }

  const showForm = status?.allowed && (editing || !status.hasKey);
  const errorLine = error ? (error.message ? `${copy.hkErrors[error.code]} (${error.message})` : copy.hkErrors[error.code]) : "";

  return (
    <div className="control-content">
      <section className="control-heading">
        <span>{copy.modelKeyKicker}</span>
        <h1>{copy.hkTitle}</h1>
        {/* Trial and paid say different things; neither is shown until we know which. */}
        {status && <p>{status.trial ? copy.hkBodyTrial : copy.hkBody}</p>}
      </section>

      {loadState === "loading" && (
        <div className="settings-state" role="status">
          <span className="mini-spinner" aria-hidden="true" />
          {copy.loadingPreferences}
        </div>
      )}

      {loadState === "error" && (
        <div className="settings-state panel-error" role="alert">
          <span>{copy.modelKeyLoadError}</span>
          <button type="button" onClick={() => void load()}>{copy.tryAgain}</button>
        </div>
      )}

      {loadState === "ready" && status && (
        <section className="byok-card">
          <header>
            <div>
              <h2>{status.hasKey ? copy.hkOwn : status.trial ? copy.hkIncludedTrial : copy.hkIncluded}</h2>
              {status.hasKey && (
                <p>{copy.hkOwnDetail(status.host ?? providerLabel(status.provider), status.model ?? "", status.keyPreview ?? "••••")}</p>
              )}
            </div>
            <span className={status.hasKey ? "byok-badge is-own" : "byok-badge"}>
              {status.hasKey ? providerLabel(status.provider) : copy.hkBadgeIncluded}
            </span>
          </header>

          {!status.allowed && <p className="byok-note">{copy.hkPaidOnly}</p>}

          {status.allowed && (status.hasKey || uncertain) && (!editing || uncertain) && (
            <div className="byok-actions">
              {status.hasKey && !editing && (
                <button type="button" className="btn btn-secondary" onClick={() => { setEditing(true); setDone(null); }}>
                  {copy.hkChange}
                </button>
              )}
              <button type="button" className="settings-reset" disabled={busy !== null} onClick={() => void useIncluded()}>
                {busy === "back" ? copy.hkSwitchingBack : copy.hkUseIncluded}
              </button>
            </div>
          )}

          {showForm && (
            <form onSubmit={save}>
              <div className="byok-providers" role="radiogroup" aria-label={copy.hkProvider}>
                {[...HERMES_PROVIDERS.map((p) => ({ id: p.id as HermesProviderId, label: p.label, note: copy.providerNote[p.id] })),
                  { id: "custom" as HermesProviderId, label: copy.hkCustom, note: copy.hkCustomNote }].map((option) => (
                  <label key={option.id} className={option.id === provider ? "selected" : ""}>
                    <input
                      type="radio"
                      name="provider"
                      value={option.id}
                      checked={option.id === provider}
                      onChange={() => { setProvider(option.id); setModels(null); setModel(""); setError(null); }}
                    />
                    <strong>{option.label}</strong>
                    <span>{option.note}</span>
                  </label>
                ))}
              </div>

              {provider === "custom" && (
                <div className="byok-field">
                  <label htmlFor="hk-base">{copy.hkBaseUrl}</label>
                  <input id="hk-base" aria-describedby="hk-base-hint" type="url" inputMode="url" autoComplete="off" spellCheck={false} maxLength={300}
                    placeholder="https://api.example.com/v1" value={baseUrl}
                    onChange={(e) => { setBaseUrl(e.target.value); setModels(null); setError(null); }} />
                  <small id="hk-base-hint">{copy.hkBaseUrlHint}</small>
                </div>
              )}

              <div className="byok-field">
                <label htmlFor="hk-key">{copy.hkKey(spec?.label ?? copy.hkCustom)}</label>
                <input id="hk-key" aria-describedby="hk-key-hint" type="password" autoComplete="off" spellCheck={false} maxLength={400}
                  placeholder={provider === "openrouter" ? "sk-or-v1-…" : "sk-…"} value={key}
                  onChange={(e) => { setKey(e.target.value); setModels(null); setError(null); }} />
                <small id="hk-key-hint">
                  {copy.hkKeyHint}
                  {spec && <>{" "}<a href={spec.keysUrl} target="_blank" rel="noopener noreferrer">{copy.hkGetKey}</a></>}
                </small>
              </div>

              <div className="byok-field">
                <label htmlFor="hk-model">{copy.hkModel}</label>
                <input id="hk-model" aria-describedby="hk-model-hint" list="hk-models" autoComplete="off" spellCheck={false} maxLength={128}
                  value={model} onChange={(e) => { setModel(e.target.value); setError(null); }} />
                <datalist id="hk-models">
                  {(models ?? []).map((m) => <option key={m} value={m} />)}
                </datalist>
                <small id="hk-model-hint" aria-live="polite">
                  {models === null ? copy.hkModelHint : models.length ? copy.hkModelsFound(models.length) : copy.hkModelsNone}
                </small>
                <div className="byok-actions">
                  <button type="button" className="btn btn-secondary" disabled={!key.trim() || busy !== null || (provider === "custom" && !baseUrl.trim())} onClick={() => void loadModels()}>
                    {busy === "models" ? copy.hkLoadingModels : copy.hkLoadModels}
                  </button>
                </div>
              </div>

              <div className="byok-actions">
                <button type="submit" className="btn btn-primary" disabled={busy !== null || !key.trim() || !MODEL_ID_RE.test(model.trim()) || (provider === "custom" && !baseUrl.trim())}>
                  {busy === "save" ? copy.hkSaving : copy.hkSave}
                </button>
                {status.hasKey && (
                  <button type="button" className="settings-reset" onClick={() => { setEditing(false); resetForm(); }}>
                    {copy.hkCancel}
                  </button>
                )}
              </div>
              <p className="byok-note">{copy.hkNote}</p>
            </form>
          )}

          {/* Always reachable for a trial or paid customer, whatever the record says: the
              record lives here, the setting lives in the assistant, and the two
              can disagree after a lost answer. On a bot already on the included
              AI it only restarts it. */}
          {status.allowed && !status.hasKey && !uncertain && (
            <div className="byok-actions">
              <span className="byok-effect">{copy.hkResetNote}</span>
              <button type="button" className="settings-reset" disabled={busy !== null} onClick={() => void useIncluded()}>
                {busy === "back" ? copy.hkSwitchingBack : copy.hkUseIncluded}
              </button>
            </div>
          )}

          {errorLine && <p className="panel-error" role="alert">{errorLine}</p>}
          {(done === "saved" || done === "back") && (
            <p className="panel-success" role="status">✓ {done === "saved" ? copy.hkSaved : copy.hkBack}</p>
          )}
          {(done === "pending" || done === "unrecorded") && (
            <p className="byok-note" role="status">{done === "pending" ? copy.hkPending : copy.hkUnrecorded}</p>
          )}
        </section>
      )}
    </div>
  );
}

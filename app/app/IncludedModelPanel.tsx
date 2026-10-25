"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Messages } from "../../lib/i18n";

/**
 * "Model" panel — pick which of the models that come with the plan the
 * assistant runs (the dashboard's model dropdown). Shown only when the platform
 * offers more than one. Everything goes through /api/included-model, which
 * resolves the bot from the session.
 */

interface View {
  choosable: boolean;
  models: { id: string; name: string }[];
  current: string | null;
}

type ErrorCode = "included_model_unavailable" | "rate_limited" | "upstream_error";

export default function IncludedModelPanel({ copy, preview, onChanged }: { copy: Messages; preview: boolean; onChanged?: () => void }) {
  const t = copy.includedModel;
  const previewView = (): View => ({ choosable: true, models: [{ id: "model-a", name: t.previewFast }, { id: "model-b", name: t.previewThorough }], current: "model-a" });
  const [view, setView] = useState<View | null>(preview ? previewView() : null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(preview ? "ready" : "loading");
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (preview) return;
    setLoadState("loading");
    try {
      const res = await fetch("/api/included-model", { cache: "no-store" });
      if (!res.ok) throw new Error("load");
      setView((await res.json()) as View);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [preview]);

  useEffect(() => { void load(); }, [load]);

  // Preview names follow the current language.
  const models = preview ? previewView().models : view?.models ?? [];
  const current = view?.current ?? null;
  const shown = pick || (current && models.some((m) => m.id === current) ? current : models[0]?.id ?? "");

  async function switchModel() {
    if (inFlight.current || !shown || shown === current) return;
    inFlight.current = true;
    setBusy(true); setError(null); setDone(false);
    try {
      if (preview) {
        setView((v) => (v ? { ...v, current: shown } : v));
        setDone(true);
        return;
      }
      const res = await fetch("/api/included-model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: shown }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const code = body.error === "included_model_unavailable" || body.error === "rate_limited" ? body.error : "upstream_error";
        setError(code);
        if (code === "included_model_unavailable") void load();
        return;
      }
      setView((v) => (v ? { ...v, current: shown } : v));
      setPick("");
      setDone(true);
      onChanged?.();
    } catch {
      setError("upstream_error");
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  return (
    <div className="control-content">
      <section className="control-heading">
        <span>{t.kicker}</span>
        <h1>{t.title}</h1>
        <p>{t.body}</p>
      </section>

      {loadState === "loading" && (
        <div className="settings-state" role="status">
          <span className="mini-spinner" aria-hidden="true" />
          {t.loading}
        </div>
      )}

      {loadState === "error" && (
        <div className="settings-state panel-error" role="alert">
          <span>{t.loadError}</span>
          <button type="button" onClick={() => void load()}>{copy.tryAgain}</button>
        </div>
      )}

      {loadState === "ready" && view && (
        <section className="byok-card">
          {!view.choosable || models.length === 0 ? (
            <p className="byok-note">{t.notOffered}</p>
          ) : (
            <>
              <div className="byok-field">
                <label htmlFor="included-model-select">{t.label}</label>
                <div className="hk-included-row">
                  <select id="included-model-select" value={shown} disabled={busy} onChange={(e) => { setPick(e.target.value); setDone(false); setError(null); }}>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === current ? ` · ${t.running}` : ""}</option>)}
                  </select>
                  <button type="button" className="btn btn-primary" disabled={busy || !shown || current === null || shown === current} onClick={() => void switchModel()}>
                    {busy ? t.switching : t.switch}
                  </button>
                </div>
                <p className="byok-note">{current === null ? t.ownRoute : t.hint}</p>
              </div>
              {done && <p className="panel-success" role="status">{t.switched}</p>}
              {error && <p className="panel-error" role="alert">{t.errors[error]}</p>}
            </>
          )}
        </section>
      )}
    </div>
  );
}

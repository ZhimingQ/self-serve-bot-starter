"use client";

import { useCallback, useEffect, useState } from "react";
import { CopyField, SectionState, errorText, toolFetch, type SectionProps } from "./shared";

interface EndpointState {
  enabled: boolean;
  baseUrl: string | null;
  rotationSupported: boolean;
}

interface Revealed {
  apiKey: string;
  baseUrl: string;
  curlExample: string | null;
}

const PREVIEW_STATE: EndpointState = {
  enabled: false,
  baseUrl: "https://api.example.com/v1",
  rotationSupported: true,
};

export default function EndpointSection({ copy, preview, status }: SectionProps) {
  const t = copy.botTools.endpoint;
  const [state, setState] = useState<EndpointState | null>(preview ? PREVIEW_STATE : null);
  const [load, setLoad] = useState<"loading" | "ready" | "error" | "unavailable">(preview ? "ready" : "loading");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"enable" | "rotate" | "disable" | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "disable" | null>(null);
  // The key exists in this component's memory only until the customer
  // dismisses it; it is never fetched again.
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (preview) return;
    setLoad("loading");
    const res = await toolFetch<EndpointState>("endpoint");
    if (res.ok) {
      setState({ enabled: res.data.enabled === true, baseUrl: res.data.baseUrl ?? null, rotationSupported: res.data.rotationSupported === true });
      setLoad("ready");
    } else if (res.status === 404) {
      setLoad("unavailable");
    } else {
      setLoadError(errorText(copy, res.data.error));
      setLoad("error");
    }
  }, [preview, copy]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function mutate(action: "enable" | "rotate" | "disable") {
    setConfirm(null);
    setError("");
    setBusy(action);
    if (preview) {
      setBusy(null);
      if (action === "disable") {
        setState({ ...PREVIEW_STATE, enabled: false });
        setRevealed(null);
      } else {
        setState({ ...PREVIEW_STATE, enabled: true });
        setRevealed({
          apiKey: "sk-preview-0000000000000000",
          baseUrl: PREVIEW_STATE.baseUrl ?? "",
          curlExample: `curl ${PREVIEW_STATE.baseUrl}/chat/completions -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"Hello"}]}'`,
        });
      }
      return;
    }
    const res = action === "disable"
      ? await toolFetch<EndpointState>("endpoint", { method: "DELETE" })
      : await toolFetch<EndpointState & { apiKey: string; curlExample: string }>("endpoint", { method: "POST", json: { action } });
    setBusy(null);
    if (!res.ok) {
      setError(errorText(copy, res.data.error));
      // A rotation the bot cannot do means the status we showed was stale.
      if (res.data.error === "rotation_unsupported" && state) setState({ ...state, rotationSupported: false });
      return;
    }
    const next = { enabled: res.data.enabled === true, baseUrl: res.data.baseUrl ?? null, rotationSupported: res.data.rotationSupported === true };
    setState(next);
    const key = (res.data as { apiKey?: unknown }).apiKey;
    if (action !== "disable" && typeof key === "string" && key) {
      const curl = (res.data as { curlExample?: unknown }).curlExample;
      setRevealed({ apiKey: key, baseUrl: next.baseUrl ?? "", curlExample: typeof curl === "string" ? curl : null });
    } else {
      setRevealed(null);
    }
  }

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
        {load === "ready" && state && (
          <span className={state.enabled ? "byok-badge is-own" : "byok-badge"}>{state.enabled ? t.on : t.off}</span>
        )}
      </header>

      {load === "loading" && <SectionState kind="loading" text={copy.botTools.loading} />}
      {load === "unavailable" && <SectionState kind="note" text={errorText(copy, "not_available")} />}
      {load === "error" && <SectionState kind="error" text={loadError} onRetry={() => void refresh()} retryLabel={copy.tryAgain} />}

      {load === "ready" && state && revealed && (
        <div className="bt-keybox" role="status">
          <p><strong>{state.rotationSupported ? t.keyWarning : t.keyWarningNoRotate}</strong></p>
          <CopyField label={t.keyLabel} value={revealed.apiKey} copy={copy} secret />
          {revealed.baseUrl && <CopyField label={t.baseUrlLabel} value={revealed.baseUrl} copy={copy} />}
          {revealed.curlExample && (
            <>
              <CopyField label={t.exampleLabel} value={revealed.curlExample} copy={copy} multiline />
              <p className="byok-note">{t.exampleNote}</p>
            </>
          )}
          <div className="byok-actions">
            <button type="button" className="btn btn-primary" onClick={() => setRevealed(null)}>{t.done}</button>
          </div>
        </div>
      )}

      {load === "ready" && state && !revealed && state.enabled && state.baseUrl && (
        <CopyField label={t.baseUrlLabel} value={state.baseUrl} copy={copy} />
      )}

      {load === "ready" && state && !revealed && (
        confirm ? (
          <div className="bt-confirm" role="alertdialog" aria-label={confirm === "rotate" ? t.rotate : t.disable}>
            <p>{confirm === "rotate" ? t.rotateConfirm : t.disableConfirm}</p>
            <div className="byok-actions">
              <button type="button" className="btn btn-danger" onClick={() => void mutate(confirm)}>{confirm === "rotate" ? t.rotate : t.disable}</button>
              <button type="button" className="settings-reset" onClick={() => setConfirm(null)}>{copy.botTools.cancel}</button>
            </div>
          </div>
        ) : state.enabled ? (
          <>
            <div className="byok-actions">
              {state.rotationSupported && (
                <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => setConfirm("rotate")}>
                  {busy === "rotate" ? copy.botTools.working : t.rotate}
                </button>
              )}
              <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => setConfirm("disable")}>
                {busy === "disable" ? copy.botTools.working : t.disable}
              </button>
            </div>
            {!state.rotationSupported && <p className="byok-note">{t.noRotate}</p>}
          </>
        ) : (
          <>
            {status !== "running" && !preview && <p className="byok-note">{copy.botTools.needsRunning}</p>}
            <div className="byok-actions">
              <button type="button" className="btn btn-primary" disabled={busy !== null || (!preview && status !== "running")} onClick={() => void mutate("enable")}>
                {busy === "enable" ? copy.botTools.working : t.enable}
              </button>
              <span className="byok-effect">{t.billingNote}</span>
            </div>
          </>
        )
      )}

      {error && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}

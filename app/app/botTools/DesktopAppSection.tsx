"use client";

import { useCallback, useEffect, useState } from "react";
import { CopyField, SectionState, errorText, toolFetch, type SectionProps } from "./shared";

const DOWNLOAD_URL = "https://hermes-agent.nousresearch.com";

interface Details {
  remoteUrl: string;
  username: string;
  password: string;
}

/**
 * Connect the Hermes Desktop app (Nous Research's own app) to this hosted
 * assistant: the customer gets a remote-gateway URL and a 30-day sign-in to
 * paste into the app. The password is shown once per click and never stored
 * in the page; clicking again simply issues fresh details.
 */
export default function DesktopAppSection({
  copy,
  preview,
  status,
  embedded = false,
}: SectionProps & {
  /** Inside the Channels dialog, which already carries the title: no card, no heading. */
  embedded?: boolean;
}) {
  const t = copy.botTools.hermesDesktop;
  const [load, setLoad] = useState<"loading" | "ready" | "error">(preview ? "ready" : "loading");
  const [available, setAvailable] = useState(preview);
  const [reason, setReason] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<Details | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "note"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (preview) return;
    setLoad("loading");
    const res = await toolFetch<{ available: boolean; reason: string | null }>("hermes-desktop");
    if (res.ok) {
      setAvailable(res.data.available === true);
      setReason(typeof res.data.reason === "string" ? res.data.reason : null);
      setLoad("ready");
    } else if (res.status === 404) {
      setAvailable(false);
      setReason("not_available");
      setLoad("ready");
    } else {
      setLoadError(errorText(copy, res.data.error));
      setLoad("error");
    }
  }, [preview, copy]);

  // Re-check when the assistant's status changes (e.g. started from Power).
  useEffect(() => { void refresh(); }, [refresh, status]);

  async function connect() {
    setMessage(null);
    if (preview) {
      setMessage({ kind: "note", text: copy.botTools.previewNote });
      return;
    }
    setBusy(true);
    const res = await toolFetch<Details>("hermes-desktop", { method: "POST" });
    setBusy(false);
    const d = res.data;
    if (!res.ok || typeof d.remoteUrl !== "string" || typeof d.username !== "string" || typeof d.password !== "string") {
      setMessage({ kind: "error", text: errorText(copy, d.error) });
      if (d.error === "bot_not_running" || res.status === 404) void refresh();
      return;
    }
    setDetails({ remoteUrl: d.remoteUrl, username: d.username, password: d.password });
  }

  const unavailableText = reason === "bot_not_running" ? copy.botTools.needsRunning : t.notAvailable;

  return (
    <section className={embedded ? "hd-embedded" : "byok-card"}>
      {embedded ? (
        <p className="hd-embedded-intro">{t.body}</p>
      ) : (
        <header>
          <div>
            <h2>{t.title}</h2>
            <p>{t.body}</p>
          </div>
        </header>
      )}

      <div className="byok-actions">
        <a className="btn btn-secondary" href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
          {t.download} <span aria-hidden="true">↗</span>
        </a>
      </div>

      {load === "loading" && <SectionState kind="loading" text={copy.botTools.loading} />}
      {load === "error" && <SectionState kind="error" text={loadError} onRetry={() => void refresh()} retryLabel={copy.tryAgain} />}
      {load === "ready" && !available && !details && <SectionState kind="note" text={unavailableText} />}

      {details ? (
        <div className="bt-keybox" role="status">
          <CopyField label={t.urlLabel} value={details.remoteUrl} copy={copy} />
          <CopyField label={t.usernameLabel} value={details.username} copy={copy} />
          <CopyField label={t.passwordLabel} value={details.password} copy={copy} secret />
          <p className="byok-note">{t.expiry}</p>
          <div className="byok-actions">
            <button type="button" className="btn btn-primary" onClick={() => setDetails(null)}>{t.done}</button>
          </div>
        </div>
      ) : (
        load === "ready" && available && (
          <div className="byok-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void connect()}>
              {busy ? t.connecting : t.connect}
            </button>
          </div>
        )
      )}

      {message && (
        <p className={message.kind === "error" ? "panel-error" : "byok-note"} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}

      <h3 className="bt-subhead">{t.stepsTitle}</h3>
      <ol className="channel-steps bt-steps">
        {t.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
    </section>
  );
}

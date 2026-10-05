"use client";

import { useCallback, useEffect, useState } from "react";
import { SectionState, errorText, toolFetch, type SectionProps } from "./shared";

export default function DesktopSection({ copy, preview, status }: SectionProps) {
  const t = copy.botTools.desktop;
  const [load, setLoad] = useState<"loading" | "ready" | "error">(preview ? "ready" : "loading");
  const [available, setAvailable] = useState(preview);
  const [reason, setReason] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "note"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (preview) return;
    setLoad("loading");
    const res = await toolFetch<{ available: boolean; reason: string | null }>("desktop");
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

  async function openDesktop() {
    setMessage(null);
    if (preview) {
      setMessage({ kind: "note", text: copy.botTools.previewNote });
      return;
    }
    // Open the tab NOW, inside the click: a window opened after an await is no
    // longer tied to the click and pop-up blockers stop it. The link is minted
    // afterwards (it is single-use and lives for about a minute, so it cannot
    // be fetched ahead of time) and the tab is pointed at it.
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setMessage({ kind: "error", text: t.popupBlocked });
      return;
    }
    tab.opener = null;
    setBusy(true);
    const res = await toolFetch<{ viewerUrl: string }>("desktop", { method: "POST" });
    setBusy(false);
    const url = res.ok ? res.data.viewerUrl : undefined;
    if (!url) {
      tab.close();
      setMessage({ kind: "error", text: errorText(copy, res.data.error) });
      if (res.data.error === "bot_not_running" || res.status === 404) void refresh();
      return;
    }
    tab.location.href = url;
    setMessage({ kind: "ok", text: t.opened });
  }

  const unavailableText = reason === "bot_not_running" ? copy.botTools.needsRunning : t.notAvailable;

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
      </header>

      {load === "loading" && <SectionState kind="loading" text={copy.botTools.loading} />}
      {load === "error" && <SectionState kind="error" text={loadError} onRetry={() => void refresh()} retryLabel={copy.tryAgain} />}
      {load === "ready" && !available && <SectionState kind="note" text={unavailableText} />}

      {load === "ready" && available && (
        <>
          <div className="byok-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void openDesktop()}>
              {busy ? t.opening : t.open} <span aria-hidden="true">↗</span>
            </button>
          </div>
          <p className="byok-note">{t.howItWorks}</p>
        </>
      )}

      {message && (
        <p
          className={message.kind === "error" ? "panel-error" : message.kind === "ok" ? "panel-success" : "byok-note"}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

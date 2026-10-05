"use client";

import { useEffect, useRef, useState } from "react";
import { errorText, statusText, toolFetch, type SectionProps } from "./shared";

type Op = "start" | "stop" | "restart";

/** Watch a bring-online action until the assistant settles: every 5s for up
 *  to two minutes, then stop rather than spin forever. */
const POLL_MS = 5000;
const POLL_LIMIT = 24;

export default function PowerSection({ copy, preview, status, onStatus }: SectionProps) {
  const t = copy.botTools.power;
  const [busy, setBusy] = useState<Op | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
  }, []);

  function watch(remaining: number) {
    pollRef.current = setTimeout(async () => {
      const res = await toolFetch<{ status: string }>("info");
      const next = res.ok ? res.data.status : undefined;
      if (next) onStatus(next);
      if (remaining > 1 && (!next || next === "starting")) watch(remaining - 1);
    }, POLL_MS);
  }

  async function run(op: Op) {
    setConfirmStop(false);
    setMessage(null);
    setBusy(op);
    if (preview) {
      onStatus(op === "stop" ? "stopped" : "running");
      setBusy(null);
      setMessage({ kind: "ok", text: t.done });
      return;
    }
    const res = await toolFetch<{ status: string }>("power", { method: "POST", json: { op } });
    setBusy(null);
    if (!res.ok) {
      setMessage({ kind: "error", text: errorText(copy, res.data.error) });
      return;
    }
    const next = res.data.status ?? "unknown";
    onStatus(next);
    setMessage({ kind: "ok", text: next === "starting" ? t.restartNote : t.done });
    if (pollRef.current) clearTimeout(pollRef.current);
    if (op !== "stop") watch(POLL_LIMIT);
  }

  const running = status === "running" || status === "starting";

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
        <span className={`byok-badge bt-status is-${status}`}>
          <i aria-hidden="true" />
          {statusText(copy, status)}
        </span>
      </header>

      {!confirmStop ? (
        <div className="byok-actions">
          <button type="button" className="btn btn-primary" disabled={busy !== null || running} onClick={() => void run("start")}>
            {busy === "start" ? t.working : t.start}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy !== null || status === "stopped"} onClick={() => void run("restart")}>
            {busy === "restart" ? t.working : t.restart}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy !== null || status === "stopped"} onClick={() => setConfirmStop(true)}>
            {busy === "stop" ? t.working : t.stop}
          </button>
        </div>
      ) : (
        <div className="bt-confirm" role="alertdialog" aria-label={t.stop}>
          <p>{t.stopConfirm}</p>
          <div className="byok-actions">
            <button type="button" className="btn btn-danger" onClick={() => void run("stop")}>{t.stop}</button>
            <button type="button" className="settings-reset" onClick={() => setConfirmStop(false)}>{copy.botTools.cancel}</button>
          </div>
        </div>
      )}

      {message && (
        <p className={message.kind === "ok" ? "panel-success" : "panel-error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.kind === "ok" ? "✓ " : ""}{message.text}
        </p>
      )}
    </section>
  );
}

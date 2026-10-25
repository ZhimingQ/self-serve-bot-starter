"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LOG_TAIL_CHOICES, LOG_TAIL_DEFAULT, type LogLine } from "../../../lib/botLogs";
import { SectionState, errorText, toolFetch, type SectionProps } from "./shared";

const PREVIEW_LINES: LogLine[] = [
  { time: "2026-10-24T09:00:01Z", stream: "stdout", text: "Gateway ready, listening for messages" },
  { time: "2026-10-24T09:00:03Z", stream: "stdout", text: "Telegram connected" },
  { time: "2026-10-24T09:14:22Z", stream: "stdout", text: "Running scheduled task \"Morning summary\"" },
  { time: "2026-10-24T09:14:31Z", stream: "stderr", text: "web_search: 1 result source timed out, using the others" },
];

function clock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function LogsSection({ copy, preview, status }: SectionProps) {
  const t = copy.botTools.logs;
  const [tail, setTail] = useState<number>(LOG_TAIL_DEFAULT);
  const [lines, setLines] = useState<LogLine[]>(preview ? PREVIEW_LINES : []);
  const [load, setLoad] = useState<"loading" | "ready" | "error">(preview ? "ready" : "loading");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLPreElement>(null);
  const seq = useRef(0);

  const refresh = useCallback(async (first: boolean) => {
    if (preview) return;
    const mine = ++seq.current;
    if (first) setLoad("loading");
    setBusy(true);
    const res = await toolFetch<{ lines: LogLine[] }>("logs", { query: { tail: String(tail) } });
    if (mine !== seq.current) return; // a newer request (another line count) owns the view
    setBusy(false);
    if (res.ok) {
      setLines(Array.isArray(res.data.lines) ? res.data.lines : []);
      setLoadError("");
      setLoad("ready");
    } else if (first) {
      setLoadError(errorText(copy, res.data.error));
      setLoad("error");
    } else {
      setLoadError(errorText(copy, res.data.error));
    }
  }, [preview, tail, copy]);

  useEffect(() => { void refresh(true); }, [refresh, status]);

  // Newest at the bottom, like a terminal: show it after every load.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function copyAll() {
    const text = lines.map((l) => `${l.time ?? ""} ${l.text}`.trim()).join("\n");
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
      </header>

      {load === "loading" && <SectionState kind="loading" text={copy.botTools.loading} />}
      {load === "error" && <SectionState kind="error" text={loadError} onRetry={() => void refresh(true)} retryLabel={copy.tryAgain} />}

      {load === "ready" && (
        <>
          <div className="bt-logs-bar">
            <label>
              {t.lines}
              <select value={tail} onChange={(e) => setTail(Number(e.target.value))} disabled={preview}>
                {LOG_TAIL_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-secondary" disabled={busy || preview} onClick={() => void refresh(false)}>
              {busy ? t.refreshing : t.refresh}
            </button>
            <button type="button" className="btn btn-secondary" disabled={!lines.length} onClick={() => void copyAll()}>
              {copied ? t.copied : t.copy}
            </button>
            <span className="bt-logs-hint">{t.newest}</span>
          </div>
          {lines.length ? (
            <pre ref={listRef} className="bt-logs" tabIndex={0} aria-label={t.listLabel}>
              {lines.map((l, i) => (
                <span key={i} className={l.stream === "stderr" ? "bt-log-line is-stderr" : "bt-log-line"}>
                  {l.time && <time dateTime={l.time}>{clock(l.time)}</time>}
                  {l.text}
                  {"\n"}
                </span>
              ))}
            </pre>
          ) : (
            <SectionState kind="note" text={t.empty} />
          )}
          {loadError && !busy && <p className="panel-error" role="alert">{loadError}</p>}
          <p className="byok-note">{t.masked}</p>
        </>
      )}
    </section>
  );
}

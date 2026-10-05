"use client";

import { useCallback, useEffect, useState } from "react";
import { CopyField, SectionState, errorText, toolFetch, type SectionProps } from "./shared";

interface Connection {
  id: string;
  deviceName: string | null;
  platform: string | null;
  status: string | null;
  online: boolean;
  folders: string[];
  access: "read" | "write";
  terminal: boolean;
  lastSeenAt: string | null;
}

interface ComputerState {
  connections: Connection[];
  connectCommand: { macosLinux: string | null; windows: string | null };
}

type Os = "macosLinux" | "windows";

const PREVIEW_STATE: ComputerState = {
  connections: [],
  connectCommand: {
    macosLinux: "curl -fsSL https://example.com/connect.sh | sh",
    windows: "irm https://example.com/connect.ps1 | iex",
  },
};

/** Refused because other people can message the assistant. */
interface Exposure {
  reasons: string[];
  /** The one setting that can be switched off on the customer's say-so. */
  canCloseTelegramGroups: boolean;
}

export default function ComputerSection({ copy, preview, status }: SectionProps) {
  const t = copy.botTools.computer;
  const [state, setState] = useState<ComputerState | null>(preview ? PREVIEW_STATE : null);
  const [load, setLoad] = useState<"loading" | "ready" | "error" | "unavailable">(preview ? "ready" : "loading");
  const [loadError, setLoadError] = useState("");
  const [os, setOs] = useState<Os>("macosLinux");
  const [code, setCode] = useState("");
  const [folders, setFolders] = useState<string[]>(["~/Documents"]);
  const [access, setAccess] = useState<"read" | "write">("read");
  const [terminal, setTerminal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [approved, setApproved] = useState(false);
  const [exposure, setExposure] = useState<Exposure | null>(null);
  const [closeGroupsAgreed, setCloseGroupsAgreed] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    // Default the command to the computer the customer is probably on.
    if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) setOs("windows");
  }, []);

  const refresh = useCallback(async () => {
    if (preview) return;
    setLoad((current) => (current === "ready" ? current : "loading"));
    const res = await toolFetch<ComputerState>("computer");
    if (res.ok) {
      setState({
        connections: Array.isArray(res.data.connections) ? res.data.connections : [],
        connectCommand: res.data.connectCommand ?? { macosLinux: null, windows: null },
      });
      setLoad("ready");
    } else if (res.status === 404) {
      setLoad("unavailable");
    } else {
      setLoadError(errorText(copy, res.data.error));
      setLoad("error");
    }
  }, [preview, copy]);

  useEffect(() => { void refresh(); }, [refresh]);

  // A just-approved computer picks the approval up on its next poll; refresh
  // the list a few times so it shows as online without a manual reload.
  useEffect(() => {
    if (!approved || preview) return;
    let n = 0;
    const timer = window.setInterval(() => {
      n += 1;
      void refresh();
      if (n >= 6) window.clearInterval(timer);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [approved, preview, refresh]);

  async function approve(closeTelegramGroups: boolean) {
    setError("");
    setApproved(false);
    const cleanFolders = folders.map((f) => f.trim()).filter(Boolean);
    if (!code.trim()) return;
    if (cleanFolders.length === 0) {
      setError(errorText(copy, "invalid_folders"));
      return;
    }
    setBusy(true);
    if (preview) {
      setBusy(false);
      setApproved(true);
      setExposure(null);
      setState((current) => ({
        ...(current ?? PREVIEW_STATE),
        connections: [{
          id: "00000000-0000-4000-8000-000000000000",
          deviceName: "My laptop",
          platform: os === "windows" ? "windows" : "darwin",
          status: "active",
          online: true,
          folders: cleanFolders,
          access,
          terminal,
          lastSeenAt: new Date().toISOString(),
        }],
      }));
      setCode("");
      return;
    }
    const res = await toolFetch("computer", {
      method: "POST",
      json: { userCode: code, folders: cleanFolders, access, terminal, closeTelegramGroups },
    });
    setBusy(false);
    if (!res.ok) {
      if (res.data.error === "bot_reachable_by_others") {
        const reasons = Array.isArray(res.data.reasons) ? (res.data.reasons as unknown[]).filter((r): r is string => typeof r === "string") : [];
        setExposure({ reasons, canCloseTelegramGroups: res.data.fix === "close_telegram_groups" });
        setCloseGroupsAgreed(false);
        return;
      }
      setError(errorText(copy, res.data.error));
      return;
    }
    setExposure(null);
    setApproved(true);
    setCode("");
    void refresh();
  }

  async function remove(id: string) {
    setConfirmRemove(null);
    setError("");
    if (preview) {
      setState((current) => (current ? { ...current, connections: current.connections.filter((c) => c.id !== id) } : current));
      return;
    }
    setBusy(true);
    const res = await toolFetch("computer", { method: "DELETE", query: { id } });
    setBusy(false);
    if (!res.ok) setError(errorText(copy, res.data.error));
    void refresh();
  }

  const command = state?.connectCommand[os] ?? null;

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
      </header>

      {load === "loading" && <SectionState kind="loading" text={copy.botTools.loading} />}
      {load === "unavailable" && <SectionState kind="note" text={errorText(copy, "not_available")} />}
      {load === "error" && <SectionState kind="error" text={loadError} onRetry={() => void refresh()} retryLabel={copy.tryAgain} />}

      {load === "ready" && state && (
        <>
          <h3 className="bt-subhead">{t.connectionsTitle}</h3>
          {state.connections.length === 0 ? (
            <p className="byok-note">{t.none}</p>
          ) : (
            <ul className="bt-connections">
              {state.connections.map((c) => {
                const name = c.deviceName || t.unnamed;
                return (
                  <li key={c.id}>
                    <div>
                      <strong>
                        <i className={c.online ? "bt-dot is-on" : "bt-dot"} aria-hidden="true" />
                        {name}
                      </strong>
                      <span>
                        {c.status === "approved" ? t.waiting : c.online ? t.online : t.offline}
                        {" · "}{c.access === "write" ? t.accessWrite : t.accessRead}
                        {c.terminal ? ` · ${t.withTerminal}` : ""}
                      </span>
                      {c.folders.length > 0 && <code>{c.folders.join(", ")}</code>}
                    </div>
                    {confirmRemove === c.id ? (
                      <div className="bt-confirm is-inline" role="alertdialog" aria-label={t.disconnect}>
                        <p>{t.disconnectConfirm(name)}</p>
                        <div className="byok-actions">
                          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove(c.id)}>{t.disconnect}</button>
                          <button type="button" className="settings-reset" onClick={() => setConfirmRemove(null)}>{copy.botTools.cancel}</button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmRemove(c.id)}>{t.disconnect}</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <h3 className="bt-subhead">{t.connectTitle}</h3>
          {status !== "running" && !preview && <p className="byok-note">{copy.botTools.needsRunning}</p>}
          <ol className="channel-steps bt-steps">
            <li>
              {t.step1}
              <div className="bt-os" role="tablist" aria-label={t.step1}>
                {(["macosLinux", "windows"] as const).map((id) => (
                  <button key={id} type="button" role="tab" aria-selected={os === id} className={os === id ? "is-active" : ""} onClick={() => setOs(id)}>
                    {id === "windows" ? t.osWindows : t.osMac}
                  </button>
                ))}
              </div>
              <small>{os === "windows" ? t.terminalHintWindows : t.terminalHintMac}</small>
              {command && <CopyField label={os === "windows" ? t.osWindows : t.osMac} value={command} copy={copy} multiline />}
            </li>
            <li>{t.step2}</li>
            <li>{t.step3}</li>
          </ol>

          <form onSubmit={(e) => { e.preventDefault(); void approve(false); }}>
            <div className="byok-field">
              <label htmlFor="bt-pair-code">{t.codeLabel}</label>
              <input
                id="bt-pair-code"
                autoComplete="off"
                spellCheck={false}
                maxLength={16}
                placeholder="ABCD-1234"
                value={code}
                onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(""); }}
              />
            </div>

            <fieldset className="bt-folders">
              <legend>{t.foldersLabel}</legend>
              {folders.map((folder, i) => (
                <div key={i} className="bt-folder-row">
                  <input
                    aria-label={`${t.foldersLabel} ${i + 1}`}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={512}
                    placeholder="~/Documents"
                    value={folder}
                    onChange={(e) => setFolders((current) => current.map((f, j) => (j === i ? e.target.value : f)))}
                  />
                  {folders.length > 1 && (
                    <button type="button" className="settings-reset" onClick={() => setFolders((current) => current.filter((_, j) => j !== i))}>{t.removeFolder}</button>
                  )}
                </div>
              ))}
              {folders.length < 10 && (
                <button type="button" className="settings-reset" onClick={() => setFolders((current) => [...current, ""])}>{t.addFolder}</button>
              )}
              <small>{t.foldersHint}</small>
            </fieldset>

            <fieldset className="bt-checks">
              <legend>{t.accessLabel}</legend>
              <label><input type="radio" name="bt-access" checked={access === "read"} onChange={() => setAccess("read")} /><span>{t.accessRead}</span></label>
              <label><input type="radio" name="bt-access" checked={access === "write"} onChange={() => setAccess("write")} /><span>{t.accessWrite}</span></label>
            </fieldset>

            <fieldset className="bt-checks">
              <legend className="sr-only">{t.terminalLabel}</legend>
              <label><input type="checkbox" checked={terminal} onChange={(e) => setTerminal(e.target.checked)} /><span>{t.terminalLabel}</span></label>
              {terminal && <p className="byok-note">{t.terminalWarning}</p>}
            </fieldset>

            <div className="byok-actions">
              <button type="submit" className="btn btn-primary" disabled={busy || !code.trim() || (!preview && status !== "running")}>
                {busy ? t.approving : t.approve}
              </button>
            </div>
          </form>

          {exposure && (
            <div className="bt-confirm" role="alert">
              <p><strong>{t.exposedTitle}</strong></p>
              <ul className="channel-steps">
                {exposure.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
              {exposure.canCloseTelegramGroups ? (
                <>
                  <label className="bt-agree">
                    <input type="checkbox" checked={closeGroupsAgreed} onChange={(e) => setCloseGroupsAgreed(e.target.checked)} />
                    <span>{t.telegramFixConfirm}</span>
                  </label>
                  <div className="byok-actions">
                    <button type="button" className="btn btn-primary" disabled={busy || !closeGroupsAgreed || !code.trim()} onClick={() => void approve(true)}>
                      {t.telegramFixRetry}
                    </button>
                    <button type="button" className="settings-reset" onClick={() => setExposure(null)}>{copy.botTools.cancel}</button>
                  </div>
                </>
              ) : (
                <p className="byok-note">{t.exposedBody}</p>
              )}
            </div>
          )}

          {approved && <p className="panel-success" role="status">✓ {t.approved}</p>}
        </>
      )}

      {error && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}

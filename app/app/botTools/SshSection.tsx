"use client";

import { useCallback, useEffect, useState } from "react";
import { CopyField, SectionState, errorText, toolFetch, type SectionProps } from "./shared";

interface SshState {
  connected: boolean;
  enrolled: boolean;
  sshEnabled: boolean;
  dnsName: string | null;
  tailnetIp: string | null;
  sshUser: string | null;
  sshCommand: string | null;
  warning: boolean;
}

const TAILSCALE_KEYS_URL = "https://login.tailscale.com/admin/settings/keys";

const EMPTY: SshState = {
  connected: false, enrolled: false, sshEnabled: false, dnsName: null, tailnetIp: null, sshUser: null, sshCommand: null, warning: false,
};

const PREVIEW_CONNECTED: SshState = {
  connected: true,
  enrolled: true,
  sshEnabled: true,
  dnsName: "my-assistant.tail1234.ts.net.",
  tailnetIp: "100.101.102.103",
  sshUser: "node",
  sshCommand: "ssh node@my-assistant.tail1234.ts.net",
  warning: false,
};

export default function SshSection({ copy, preview, status }: SectionProps) {
  const t = copy.botTools.ssh;
  const [state, setState] = useState<SshState | null>(preview ? EMPTY : null);
  const [load, setLoad] = useState<"loading" | "ready" | "error" | "unavailable">(preview ? "ready" : "loading");
  const [loadError, setLoadError] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (preview) return;
    setLoad("loading");
    const res = await toolFetch<SshState>("ssh");
    if (res.ok) {
      setState({ ...EMPTY, ...res.data } as SshState);
      setLoad("ready");
    } else if (res.status === 404) {
      setLoad("unavailable");
    } else {
      setLoadError(errorText(copy, res.data.error));
      setLoad("error");
    }
  }, [preview, copy]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    const key = authKey.trim();
    if (!key || busy) return;
    setError("");
    if (!/^tskey-auth-/.test(key)) {
      setError(errorText(copy, "invalid_auth_key"));
      return;
    }
    setBusy("connect");
    if (preview) {
      setState(PREVIEW_CONNECTED);
      setAuthKey("");
      setBusy(null);
      return;
    }
    const res = await toolFetch<SshState>("ssh", { method: "POST", json: { authKey: key } });
    setBusy(null);
    if (!res.ok) {
      setError(errorText(copy, res.data.error));
      return;
    }
    setAuthKey("");
    setState({ ...EMPTY, ...res.data } as SshState);
  }

  async function disconnect() {
    setConfirmDisconnect(false);
    setError("");
    setBusy("disconnect");
    if (preview) {
      setState(EMPTY);
      setBusy(null);
      return;
    }
    const res = await toolFetch<SshState>("ssh", { method: "DELETE" });
    setBusy(null);
    if (!res.ok) {
      setError(errorText(copy, res.data.error));
      return;
    }
    setState({ ...EMPTY, ...res.data } as SshState);
  }

  const ready = state?.connected && state.sshEnabled && state.sshCommand;
  const joined = state?.enrolled || state?.connected;

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
        {load === "ready" && (
          <span className={ready ? "byok-badge is-own" : "byok-badge"}>{ready ? t.connected : t.notConnected}</span>
        )}
      </header>

      {load === "loading" && <SectionState kind="loading" text={copy.botTools.loading} />}
      {load === "unavailable" && <SectionState kind="note" text={errorText(copy, "ssh_unavailable")} />}
      {load === "error" && <SectionState kind="error" text={loadError} onRetry={() => void refresh()} retryLabel={copy.tryAgain} />}

      {load === "ready" && state && ready && (
        <>
          <CopyField label={t.commandLabel} value={state.sshCommand ?? ""} copy={copy} />
          <dl className="bt-facts">
            {state.dnsName && (<><dt>{t.machineLabel}</dt><dd>{state.dnsName.replace(/\.$/, "")}</dd></>)}
            {state.tailnetIp && (<><dt>{t.addressLabel}</dt><dd>{state.tailnetIp}</dd></>)}
          </dl>
          {state.warning && <p className="byok-note">{t.warning}</p>}
        </>
      )}

      {load === "ready" && state && joined && !ready && <p className="byok-note">{t.pending}</p>}

      {load === "ready" && state && joined && (
        !confirmDisconnect ? (
          <div className="byok-actions">
            <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => setConfirmDisconnect(true)}>
              {busy === "disconnect" ? copy.botTools.working : t.disconnect}
            </button>
            {!ready && <button type="button" className="settings-reset" onClick={() => void refresh()}>{copy.botTools.refresh}</button>}
          </div>
        ) : (
          <div className="bt-confirm" role="alertdialog" aria-label={t.disconnect}>
            <p>{t.disconnectConfirm}</p>
            <div className="byok-actions">
              <button type="button" className="btn btn-danger" onClick={() => void disconnect()}>{t.disconnect}</button>
              <button type="button" className="settings-reset" onClick={() => setConfirmDisconnect(false)}>{copy.botTools.cancel}</button>
            </div>
          </div>
        )
      )}

      {load === "ready" && state && !joined && (
        <form onSubmit={connect}>
          <h3 className="bt-subhead">{t.stepsTitle}</h3>
          <ol className="channel-steps">
            <li>
              {t.step1}{" "}
              <a href={TAILSCALE_KEYS_URL} target="_blank" rel="noopener noreferrer">{t.step1Link} ↗</a>
            </li>
            <li>{t.step2}</li>
            <li>{t.step3}</li>
          </ol>
          {status !== "running" && <p className="byok-note">{copy.botTools.needsRunning}</p>}
          <div className="byok-field">
            <label htmlFor="bt-ssh-key">{t.keyLabel}</label>
            <input
              id="bt-ssh-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              placeholder="tskey-auth-…"
              value={authKey}
              onChange={(e) => { setAuthKey(e.target.value); setError(""); }}
            />
            <small>{t.keyNote}</small>
          </div>
          <div className="byok-actions">
            <button type="submit" className="btn btn-primary" disabled={!authKey.trim() || busy !== null || (!preview && status !== "running")}>
              {busy === "connect" ? copy.botTools.working : t.connect}
            </button>
          </div>
          {busy === "connect" && <SectionState kind="loading" text={t.connecting} />}
        </form>
      )}

      {error && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}

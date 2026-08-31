"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Messages } from "../../lib/i18n";

/**
 * "Channels" panel — the customer connects their assistant to the apps they
 * already use: WeChat, Telegram, WhatsApp, Discord, Lark, Slack.
 *
 * Everything goes through /api/channels, which resolves the bot from the SESSION
 * and re-checks the storefront's own channel offer server-side. This component
 * knows no instance id and holds no credential: a bot token typed here is posted
 * once, validated by the platform against that platform's API, and never stored
 * by the storefront.
 *
 * TWO FLOW SHAPES, and the difference matters to the customer:
 *
 *   QR (WeChat, WhatsApp) — connect, then poll for a code, then keep polling
 *     until the scan lands. A first WeChat connect installs a plugin, so the poll
 *     can legitimately answer "still installing" for 2-4 minutes; the panel says
 *     so rather than spinning silently, because a customer watching an
 *     explanation-free spinner for three minutes concludes it is broken.
 *
 *   Token (Telegram, Discord, Lark, Slack) — paste a bot token, wait out the
 *     restart, then approve a pairing code the bot DMs back. The pairing step is
 *     not optional politeness: it is what keeps the bot's DM policy closed, so
 *     nobody who finds the bot can talk to somebody else's assistant.
 */

type ChannelId = "wechat" | "telegram" | "whatsapp" | "discord" | "feishu" | "slack";

const QR_CHANNELS: ChannelId[] = ["wechat", "whatsapp"];
const ICONS: Record<ChannelId, string> = {
  wechat: "◎",
  telegram: "✈",
  whatsapp: "✆",
  discord: "◉",
  feishu: "✦",
  slack: "#",
};

/** How long between QR polls. Slow enough not to hammer the login provider
 *  (which reacts badly to tight loops), fast enough that a scanned code is
 *  noticed while the customer still has the phone in hand. */
const QR_POLL_MS = 4000;

/** Disconnect watch: every 5s for up to two minutes. A disconnect restarts the
 *  bot (about a minute), so the first few polls legitimately still see the
 *  channel; two minutes is comfortably past that without spinning forever on a
 *  mutation that actually failed. */
const DISCONNECT_POLL_MS = 5000;
const DISCONNECT_POLL_LIMIT = 24;

interface ChannelsState {
  status: string;
  channels: { platform: string; paired: boolean }[];
  /** Tiles to render: what this storefront offers, PLUS anything already
   *  connected — so narrowing the offer never strands a customer with a live
   *  channel and no way to disconnect it. */
  tiles: ChannelId[];
  /** Of those, the ones a customer may still connect. */
  connectable: ChannelId[];
  disconnectable: ChannelId[];
  pairing: ChannelId[];
}

type ModalStep = "form" | "applying" | "qr" | "pairing" | "done" | "failed" | "confirm-disconnect";

interface ModalState {
  platform: ChannelId;
  step: ModalStep;
  /** What the customer set out to do — the "done" screen says something
   *  different for a disconnect than for a connect. */
  intent?: "connect" | "disconnect";
  qrDataUrl?: string;
  installing?: boolean;
  error?: string;
  busy?: boolean;
}

const PREVIEW_STATE: ChannelsState = {
  status: "running",
  channels: [{ platform: "wechat", paired: true }],
  tiles: ["wechat", "telegram", "whatsapp", "discord", "feishu", "slack"],
  connectable: ["wechat", "telegram", "whatsapp", "discord", "feishu", "slack"],
  disconnectable: ["wechat", "telegram", "whatsapp", "discord", "feishu", "slack"],
  pairing: ["telegram", "discord", "feishu"],
};

export default function ChannelsPanel({ copy, preview }: { copy: Messages; preview: boolean }) {
  const [state, setState] = useState<ChannelsState | null>(preview ? PREVIEW_STATE : null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(preview ? "ready" : "loading");
  const [modal, setModal] = useState<ModalState | null>(null);
  const [botToken, setBotToken] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [pairingCode, setPairingCode] = useState("");

  // The QR poll re-arms itself for minutes. Without a generation counter, closing
  // the modal and reopening it for another channel would leave the first chain
  // running and writing its QR into the second channel's dialog.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGenerationRef = useRef(0);
  // The poll chain outlives the render that started it, so it reads the channel
  // state through a ref. Depending on `state` directly would either capture a
  // stale copy or rebuild the callback on every refresh mid-poll.
  const stateRef = useRef<ChannelsState | null>(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const stopPolling = useCallback(() => {
    pollGenerationRef.current += 1;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const load = useCallback(async () => {
    if (preview) return;
    setLoadState("loading");
    try {
      const res = await fetch("/api/channels", { cache: "no-store" });
      if (!res.ok) throw new Error("load failed");
      setState((await res.json()) as ChannelsState);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [preview]);

  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  }, []);

  /** Map a platform error code to a line the customer can act on. Anything
   *  unrecognized falls back to our own generic copy rather than showing a code. */
  const errorFor = useCallback((status: number, code: unknown): string => {
    if (status === 429) return copy.channelErrorRateLimited;
    switch (code) {
      case "invalid_token": return copy.channelErrorInvalidToken;
      case "duplicate_token": return copy.channelErrorDuplicate;
      case "code_expired": return copy.channelErrorExpiredCode;
      case "invalid_code": return copy.channelErrorInvalidCode;
      case "not_running": return copy.channelsBotStopped;
      default: return copy.channelErrorGeneric;
    }
  }, [copy]);

  const pollQr = useCallback((platform: ChannelId, generation: number) => {
    pollTimerRef.current = setTimeout(async () => {
      if (generation !== pollGenerationRef.current) return;
      const { ok, status, data } = await post({ action: "qr", platform });
      if (generation !== pollGenerationRef.current) return;
      if (!ok) {
        // Stop the loop and offer a retry rather than polling a flow that has
        // already failed — a QR that will never arrive is not worth waiting for.
        setModal((current) => (current ? { ...current, step: "failed", qrDataUrl: undefined, error: errorFor(status, data.error) } : current));
        return;
      }
      if (data.connected) {
        // A scanned QR is not always the end of the flow. Hermes layers per-user
        // pairing on top of the account login, so on those channels the customer
        // still has to send a code — going straight to "done" would leave them
        // with a channel that looks finished and never answers them.
        const stillNeedsPairing = (stateRef.current?.pairing ?? []).includes(platform);
        setModal((current) => (current
          ? { ...current, step: stillNeedsPairing ? "pairing" : "done", qrDataUrl: undefined }
          : current));
        void load();
        return;
      }
      if (typeof data.qr_data_url === "string") {
        setModal((current) => (current ? { ...current, step: "qr", qrDataUrl: data.qr_data_url as string, installing: false } : current));
      } else {
        setModal((current) => (current ? { ...current, step: "qr", installing: Boolean(data.installing) } : current));
      }
      pollQr(platform, generation);
    }, QR_POLL_MS);
  }, [post, load, errorFor]);

  /**
   * Watch a disconnect through to completion.
   *
   * The disconnect itself returns immediately and applies in the background over
   * about a minute, so a single refresh right afterwards almost always still
   * reports the channel connected — leaving the dialog spinning with no end. This
   * polls the real status until the channel is gone, then says so. It gives up
   * after DISCONNECT_POLL_LIMIT rather than spinning forever: the mutation may
   * genuinely have failed, and "check back in a minute" beats a permanent spinner.
   */
  const pollUntilGone = useCallback((platform: ChannelId, generation: number, attempt = 0) => {
    pollTimerRef.current = setTimeout(async () => {
      if (generation !== pollGenerationRef.current) return;
      try {
        const res = await fetch("/api/channels", { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as ChannelsState;
          if (generation !== pollGenerationRef.current) return;
          setState(next);
          setLoadState("ready");
          // An empty channel list only means "disconnected" once the bot is
          // RUNNING again. A disconnect restarts it, and a bot that is not
          // running reports no channels at all — so accepting absence on its own
          // would declare success a few seconds in, every time, and would say
          // the same thing about a recreate that failed and never came back.
          if (next.status === "running" && !next.channels.some((c) => c.platform === platform)) {
            setModal((current) => (current ? { ...current, step: "done" } : current));
            return;
          }
        }
      } catch {
        // A transient failure is not an answer — keep watching until the limit.
      }
      if (attempt + 1 >= DISCONNECT_POLL_LIMIT) {
        setModal((current) => (current ? { ...current, step: "failed", error: copy.channelErrorGeneric } : current));
        return;
      }
      pollUntilGone(platform, generation, attempt + 1);
    }, DISCONNECT_POLL_MS);
  }, [copy]);

  function openConnect(platform: ChannelId) {
    stopPolling();
    setBotToken(""); setAppId(""); setAppSecret(""); setPairingCode("");
    setModal({ platform, step: QR_CHANNELS.includes(platform) ? "applying" : "form" });
    if (QR_CHANNELS.includes(platform)) void startConnect(platform);
  }

  function closeModal() {
    stopPolling();
    setModal(null);
    void load();
  }

  async function startConnect(platform: ChannelId, creds?: { botToken?: string; appId?: string; appSecret?: string }) {
    setModal((current) => (current ? { ...current, busy: true, error: undefined } : current));

    if (preview) {
      // The public demo never reaches a real bot: show the shape of the flow.
      setModal({ platform, step: QR_CHANNELS.includes(platform) ? "qr" : "pairing", installing: false });
      return;
    }

    const { ok, status, data } = await post({ action: "connect", platform, ...creds });
    if (!ok) {
      // A token platform goes back to its form so the customer can fix what they
      // pasted. A QR platform has no form to go back to — leaving it on the
      // spinner would be a lie, so it gets an explicit failed state with a retry.
      setModal((current) => (current
        ? { ...current, busy: false, step: QR_CHANNELS.includes(platform) ? "failed" : "form", error: errorFor(status, data.error) }
        : current));
      return;
    }
    if (QR_CHANNELS.includes(platform)) {
      // `applying: false` means Hermes only cleared stale session state — the code
      // can be ready within seconds, so start polling immediately either way.
      setModal({ platform, step: "qr", installing: Boolean(data.applying) });
      const generation = ++pollGenerationRef.current;
      pollQr(platform, generation);
      return;
    }
    setModal({ platform, step: "pairing" });
  }

  async function approvePairing(platform: ChannelId) {
    const code = pairingCode.trim();
    if (!code) return;
    setModal((current) => (current ? { ...current, busy: true, error: undefined } : current));
    if (preview) { setModal({ platform, step: "done" }); return; }
    const { ok, status, data } = await post({ action: "pairing_approve", platform, code });
    if (!ok) {
      setModal((current) => (current ? { ...current, busy: false, error: errorFor(status, data.error) } : current));
      return;
    }
    if (data.approved === false) {
      setModal((current) => (current ? { ...current, busy: false, error: copy.channelErrorExpiredCode } : current));
      return;
    }
    setModal({ platform, step: "done" });
    void load();
  }

  async function disconnect(platform: ChannelId) {
    setModal((current) => (current ? { ...current, busy: true, error: undefined } : current));
    if (preview) { closeModal(); return; }
    const { ok, status, data } = await post({ action: "disconnect", platform });
    if (!ok) {
      setModal((current) => (current ? { ...current, busy: false, error: errorFor(status, data.error) } : current));
      return;
    }
    // Watch it through rather than refreshing once: the mutation is still
    // running, so an immediate reload would say "connected" and stay there.
    setModal({ platform, step: "applying", intent: "disconnect" });
    const generation = ++pollGenerationRef.current;
    pollUntilGone(platform, generation);
  }

  const connected = new Set((state?.channels ?? []).map((c) => c.platform));
  /** Configured but NOT yet paired. A channel can be fully connected on the bot
   *  and still ignore the customer until their account is paired — Hermes WeChat
   *  always works this way, and a token channel lands here whenever someone closes
   *  the dialog on "I'll do this later". Without this distinction the tile reads
   *  "Connected" while the assistant stays silent, which is the worst of both. */
  const unpaired = new Set(
    (state?.channels ?? []).filter((c) => !c.paired).map((c) => c.platform),
  );
  const tiles = state?.tiles ?? [];
  const name = (id: ChannelId) => copy.channelName[id];
  const needsPairing = (id: ChannelId) => connected.has(id) && unpaired.has(id) && (state?.pairing ?? []).includes(id);

  function resumePairing(platform: ChannelId) {
    stopPolling();
    setPairingCode("");
    setModal({ platform, step: "pairing" });
  }

  return (
    <div className="control-content">
      <section className="control-heading">
        <span>{copy.channelsKicker}</span>
        <h1>{copy.channelsTitle}</h1>
        <p>{copy.channelsBody}</p>
      </section>

      {loadState === "loading" && (
        <div className="settings-state" role="status">
          <span className="mini-spinner" aria-hidden="true" />
          {copy.loadingPreferences}
        </div>
      )}

      {loadState === "error" && (
        <div className="settings-state panel-error" role="alert">
          <span>{copy.channelsLoadError}</span>
          <button type="button" onClick={() => void load()}>{copy.tryAgain}</button>
        </div>
      )}

      {loadState === "ready" && state && state.status !== "running" && (
        <div className="settings-state panel-error" role="status">
          <span>{copy.channelsBotStopped}</span>
        </div>
      )}

      {loadState === "ready" && (
        <section className="channel-grid">
          {tiles.map((id) => {
            const isConnected = connected.has(id);
            const pending = needsPairing(id);
            return (
              <article key={id} className={isConnected ? "channel-card is-connected" : "channel-card"}>
                <header>
                  <i className={`channel-icon channel-${id}`} aria-hidden="true">{ICONS[id]}</i>
                  <strong>{name(id)}</strong>
                  {isConnected && (
                    <span className={pending ? "channel-state is-pending" : "channel-state"}>
                      {pending ? copy.channelPairingNeeded : copy.channelConnected}
                    </span>
                  )}
                </header>
                {/* The blurb stays on a connected tile: the badge already says
                    "Connected", and repeating it as the body wastes the one line
                    that could remind the customer how the channel works. */}
                <p>{copy.channelBlurb[id]}</p>
                {pending ? (
                  // Pairing is the obvious next step, but not the only one a
                  // customer may want: someone who pasted the wrong bot's token
                  // needs to undo it, and offering only "Finish pairing" would
                  // leave them holding a channel they cannot finish or remove.
                  <div className="channel-card-actions">
                    <button type="button" className="btn btn-primary" disabled={state?.status !== "running"} onClick={() => resumePairing(id)}>
                      {copy.channelFinishPairing}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={!(state?.disconnectable ?? []).includes(id) || state?.status !== "running"}
                      onClick={() => { stopPolling(); setModal({ platform: id, step: "confirm-disconnect" }); }}
                    >
                      {copy.channelDisconnect}
                    </button>
                  </div>
                ) : isConnected ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!(state?.disconnectable ?? []).includes(id) || state?.status !== "running"}
                    onClick={() => { stopPolling(); setModal({ platform: id, step: "confirm-disconnect" }); }}
                  >
                    {copy.channelDisconnect}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={state?.status !== "running" || !(state?.connectable ?? []).includes(id)}
                    onClick={() => openConnect(id)}
                  >
                    {copy.channelConnect}
                  </button>
                )}
              </article>
            );
          })}
          {tiles.length === 0 && <p className="byok-note">{copy.channelsEmpty}</p>}
        </section>
      )}

      {modal && (
        <div className="channel-modal-backdrop" role="dialog" aria-modal="true" aria-label={copy.channelConnectTitle(name(modal.platform))}>
          <div className="channel-modal">
            <header>
              <i className={`channel-icon channel-${modal.platform}`} aria-hidden="true">{ICONS[modal.platform]}</i>
              <strong>
                {modal.step === "confirm-disconnect"
                  ? copy.channelDisconnectTitle(name(modal.platform))
                  : copy.channelConnectTitle(name(modal.platform))}
              </strong>
              <button type="button" className="channel-modal-close" onClick={closeModal} aria-label={copy.channelClose}>✕</button>
            </header>

            <div className="channel-modal-body">
              {modal.step === "confirm-disconnect" && (
                <>
                  <p>{copy.channelDisconnectBody(name(modal.platform))}</p>
                  <div className="byok-actions">
                    <button type="button" className="btn btn-primary" disabled={modal.busy} onClick={() => void disconnect(modal.platform)}>
                      {copy.channelDisconnect}
                    </button>
                    <button type="button" className="settings-reset" onClick={closeModal}>{copy.channelCancel}</button>
                  </div>
                </>
              )}

              {modal.step === "form" && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void startConnect(modal.platform, modal.platform === "feishu" ? { appId, appSecret } : { botToken });
                  }}
                >
                  {modal.platform === "feishu" ? (
                    <>
                      <div className="byok-field">
                        <label htmlFor="app-id">{copy.channelAppIdLabel}</label>
                        <input id="app-id" value={appId} autoComplete="off" onChange={(e) => setAppId(e.target.value)} />
                      </div>
                      <div className="byok-field">
                        <label htmlFor="app-secret">{copy.channelAppSecretLabel}</label>
                        <input id="app-secret" type="password" value={appSecret} autoComplete="off" onChange={(e) => setAppSecret(e.target.value)} />
                        <small>{copy.channelTokenHelp.feishu}</small>
                      </div>
                    </>
                  ) : (
                    <div className="byok-field">
                      <label htmlFor="bot-token">{copy.channelTokenLabel}</label>
                      <input id="bot-token" type="password" value={botToken} autoComplete="off" spellCheck={false} onChange={(e) => setBotToken(e.target.value)} />
                      <small>
                        {modal.platform === "telegram" && copy.channelTokenHelp.telegram}
                        {modal.platform === "discord" && copy.channelTokenHelp.discord}
                        {modal.platform === "slack" && copy.channelTokenHelp.slack}
                      </small>
                    </div>
                  )}
                  <div className="byok-actions">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={modal.busy || (modal.platform === "feishu" ? !(appId.trim() && appSecret.trim()) : !botToken.trim())}
                    >
                      {copy.channelConnect}
                    </button>
                    <button type="button" className="settings-reset" onClick={closeModal}>{copy.channelCancel}</button>
                  </div>
                </form>
              )}

              {modal.step === "applying" && (
                <div className="channel-applying" role="status">
                  <span className="spinner" aria-hidden="true" />
                  <p>{modal.platform === "wechat" ? copy.channelApplyingWechat : copy.channelApplying}</p>
                </div>
              )}

              {modal.step === "qr" && (
                <>
                  {modal.qrDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the bot, not an asset Next can optimize
                    <img className="channel-qr" src={modal.qrDataUrl} alt={copy.channelConnectTitle(name(modal.platform))} />
                  ) : (
                    <div className="channel-applying" role="status">
                      <span className="spinner" aria-hidden="true" />
                      <p>{modal.installing ? copy.channelApplyingWechat : copy.channelQrWaiting}</p>
                    </div>
                  )}
                  <ol className="channel-steps">
                    {(modal.platform === "wechat" ? copy.channelQrSteps.wechat : copy.channelQrSteps.whatsapp).map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </>
              )}

              {modal.step === "pairing" && (
                <>
                  <p>{copy.channelApplying}</p>
                  <p className="channel-pairing-intro">{copy.channelPairingIntro(name(modal.platform))}</p>
                  <div className="byok-field">
                    <label htmlFor="pairing-code">{copy.channelPairingLabel}</label>
                    <input
                      id="pairing-code"
                      value={pairingCode}
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={12}
                      onChange={(e) => setPairingCode(e.target.value)}
                    />
                  </div>
                  <div className="byok-actions">
                    <button type="button" className="btn btn-primary" disabled={modal.busy || !pairingCode.trim()} onClick={() => void approvePairing(modal.platform)}>
                      {copy.channelPairingApprove}
                    </button>
                    <button type="button" className="settings-reset" onClick={closeModal}>{copy.channelPairingLater}</button>
                  </div>
                </>
              )}

              {modal.step === "failed" && (
                <div className="byok-actions">
                  {/* Retry only makes sense for a connect. A disconnect that ran
                      past the watch window may still be applying, so offering
                      "Connect" there would invite the customer to undo it. */}
                  {modal.intent !== "disconnect" && (
                    <button type="button" className="btn btn-primary" disabled={modal.busy} onClick={() => void startConnect(modal.platform)}>
                      {copy.channelConnect}
                    </button>
                  )}
                  <button type="button" className="settings-reset" onClick={closeModal}>{copy.channelClose}</button>
                </div>
              )}

              {modal.step === "done" && (
                <>
                  <p className="panel-success" role="status">
                    ✓ {modal.intent === "disconnect"
                      ? copy.channelDisconnected
                      : QR_CHANNELS.includes(modal.platform) ? copy.channelQrScanned : copy.channelPairingApproved}
                  </p>
                  <div className="byok-actions">
                    <button type="button" className="btn btn-primary" onClick={closeModal}>{copy.channelClose}</button>
                  </div>
                </>
              )}

              {modal.error && <p className="panel-error" role="alert">{modal.error}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

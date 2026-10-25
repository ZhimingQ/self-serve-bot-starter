"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Messages } from "../../lib/i18n";
import { formatBytes, type BotState, type BotView } from "../../lib/botInfo";

/**
 * The customer's own assistant: status, what it runs on, and Restart/Start.
 * One poll (useBotInfo, in ChatApp) feeds the top-bar status pill, the
 * "My assistant" page and the card at the top of Usage, so they always agree.
 */

const POLL_MS = 30_000;
/** While it is coming back after Restart/Start, check far more often. */
const FAST_POLL_MS = 3_000;
/** Give up waiting (and say so) if it is not back by then. */
const ACTION_GIVE_UP_MS = 180_000;
/** A status check that has not answered by then is a failed one. */
const LOAD_TIMEOUT_MS = 15_000;
/** The server holds a restart up to ~120s; past that, stop waiting on the reply
 *  and let the fast poll see the bot come back. */
const ACTION_TIMEOUT_MS = 130_000;

export type BotAction = "restart" | "start";
export type ActionState =
  | { kind: "idle" }
  /** confirmed: the platform answered OK, so the restart has happened and any
   *  running state now is the new one. Until then (a slow reply still on its
   *  way) only a NEW start time proves it. */
  | { kind: "working"; id: number; action: BotAction; since: number; prevStartedAt: string | null; confirmed: boolean }
  | { kind: "done" }
  | { kind: "error"; message: string };

export interface BotInfoState {
  bot: BotView | null;
  /** The last check failed; what is shown may be stale. */
  loadError: boolean;
  /** This account has no assistant (yet). */
  noInstance: boolean;
  action: ActionState;
  run: (action: BotAction) => Promise<void>;
}

/** fetch + JSON body, all within `ms` (a stalled body read counts), and
 *  abandoned when `outer` aborts. */
async function fetchJsonWithin(url: string, init: RequestInit, ms: number, outer?: AbortSignal): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  outer?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = (await res.json().catch((e: unknown) => {
      if (ctrl.signal.aborted) throw e;
      return {};
    })) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

export function useBotInfo(enabled: boolean, copy: Messages["bot"]): BotInfoState {
  const [bot, setBot] = useState<BotView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [noInstance, setNoInstance] = useState(false);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const actionRef = useRef(action);
  actionRef.current = action;
  const nextId = useRef(0);
  const botRef = useRef(bot);
  botRef.current = bot;
  /** False once the component is gone: late replies then change nothing. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const setActionNow = useCallback((next: ActionState) => {
    actionRef.current = next;
    if (alive.current) setAction(next);
  }, []);

  /** Finish a Restart/Start once the bot is back. `askedAt` is when that status
   *  was requested: an answer to a question asked before this action began
   *  says nothing about it. */
  const settle = useCallback((next: BotView | null, askedAt: number) => {
    const a = actionRef.current;
    if (a.kind !== "working" || askedAt < a.since) return;
    const back = next?.state === "running" && (a.confirmed || Boolean(next.startedAt && next.startedAt !== a.prevStartedAt));
    if (back) setActionNow({ kind: "done" });
  }, [setActionNow]);

  // Requests can overlap (a poll and a post-restart recheck); an answer older
  // than one already shown is dropped, so the view never steps back in time.
  const issued = useRef(0);
  const applied = useRef(0);

  const load = useCallback(async (signal?: AbortSignal): Promise<BotView | null> => {
    const seq = ++issued.current;
    try {
      const res = await fetchJsonWithin("/api/bot", { cache: "no-store" }, LOAD_TIMEOUT_MS, signal);
      if (signal?.aborted || !alive.current || seq < applied.current) return null;
      applied.current = seq;
      if (res.status === 409) {
        setBot(null);
        setNoInstance(true);
        setLoadError(false);
        return null;
      }
      if (!res.ok) throw new Error(String(res.status));
      const next = (res.body.bot as BotView | undefined) ?? null;
      setBot(next);
      setNoInstance(false);
      setLoadError(false);
      return next;
    } catch {
      if (!signal?.aborted && alive.current && seq >= applied.current) {
        applied.current = seq;
        setLoadError(true);
      }
      return null;
    }
  }, []);

  // Steady poll, paused while the tab is hidden (like the dashboard's). One
  // request at a time: a tab coming back while a check is in flight waits for it.
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const schedule = () => {
      clearTimeout(timer);
      if (!ctrl.signal.aborted) timer = setTimeout(tick, actionRef.current.kind === "working" ? FAST_POLL_MS : POLL_MS);
    };
    const tick = async () => {
      if (ctrl.signal.aborted || busy) return;
      busy = true;
      try {
        if (document.visibilityState === "visible") {
          const askedAt = Date.now();
          settle(await load(ctrl.signal), askedAt);
        }
      } finally {
        busy = false;
      }
      schedule();
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || busy) return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, load, settle, action.kind]);

  // Give up on its own clock, so a stalled request or a hidden tab cannot leave
  // the button spinning forever.
  const workingId = action.kind === "working" ? action.id : null;
  useEffect(() => {
    if (workingId === null) return;
    const a = actionRef.current;
    const left = a.kind === "working" ? Math.max(0, ACTION_GIVE_UP_MS - (Date.now() - a.since)) : 0;
    const t = setTimeout(() => {
      const cur = actionRef.current;
      if (cur.kind === "working" && cur.id === workingId) setActionNow({ kind: "error", message: copy.actionFailed });
    }, left);
    return () => clearTimeout(t);
  }, [workingId, copy.actionFailed, setActionNow]);

  // "Back online" fades after a few seconds.
  useEffect(() => {
    if (action.kind !== "done") return;
    const t = setTimeout(() => setActionNow({ kind: "idle" }), 6_000);
    return () => clearTimeout(t);
  }, [action.kind, setActionNow]);

  const run = useCallback(async (which: BotAction) => {
    if (actionRef.current.kind === "working") return; // a second click is ignored
    const id = ++nextId.current;
    setActionNow({ kind: "working", id, action: which, since: Date.now(), prevStartedAt: botRef.current?.startedAt ?? null, confirmed: false });
    /** Only the action this reply belongs to may be finished by it. */
    const current = () => {
      const a = actionRef.current;
      return a.kind === "working" && a.id === id ? a : null;
    };
    /** Re-read the status and finish THIS action if it is back. */
    const recheck = async () => {
      const askedAt = Date.now();
      const next = await load();
      if (current()) settle(next, askedAt);
    };
    let res: Awaited<ReturnType<typeof fetchJsonWithin>>;
    try {
      res = await fetchJsonWithin("/api/bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: which }),
      }, ACTION_TIMEOUT_MS);
    } catch {
      // No reply in time: it is probably still coming back. The fast poll and
      // the give-up timer decide.
      if (current()) await recheck();
      return;
    }
    const a = current();
    if (!a) return;
    // OK: the platform has restarted it. 504: it is still bringing it back,
    // and the fast poll finishes the job.
    if (res.ok || res.status === 504) {
      if (res.ok) setActionNow({ ...a, confirmed: true });
      await recheck();
      return;
    }
    const err = typeof res.body.error === "string" ? res.body.error : "";
    setActionNow({
      kind: "error",
      message: err === "rate_limited" ? copy.rateLimited : err === "plan_required" ? copy.planRequired : copy.actionFailed,
    });
  }, [copy, load, settle, setActionNow]);

  return { bot, loadError, noInstance, action, run };
}

/** The label a state shows in the top bar. Running keeps the familiar "Online now". */
export function pillLabel(state: BotState | null, copy: Messages["bot"], onlineNow: string): string {
  if (!state || state === "running") return onlineNow;
  return copy.pill[state];
}

function ago(iso: string, now: number, copy: Messages["bot"]): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 1) return copy.justNow;
  if (mins < 60) return copy.minutesAgo(mins);
  const hours = Math.round(mins / 60);
  if (hours < 48) return copy.hoursAgo(hours);
  return copy.daysAgo(Math.round(hours / 24));
}

function ActionButtons({ info, copy, disabled }: { info: BotInfoState; copy: Messages["bot"]; disabled: boolean }) {
  const { bot, action, run } = info;
  const working = action.kind === "working";
  const canStart = bot?.state === "stopped" || bot?.state === "sleeping";
  return (
    <div className="bot-actions">
      {canStart ? (
        <button className="btn btn-primary" onClick={() => void run("start")} disabled={disabled || working}>
          {working ? copy.starting : copy.start}
        </button>
      ) : (
        <button className="btn btn-secondary" onClick={() => void run("restart")} disabled={disabled || working || !bot || bot.state === "starting"}>
          {working ? copy.restarting : copy.restart}
        </button>
      )}
    </div>
  );
}

function ActionLine({ info, copy, now }: { info: BotInfoState; copy: Messages["bot"]; now: number }) {
  const { action } = info;
  if (action.kind === "working") {
    const secs = Math.max(0, Math.round((now - action.since) / 1000));
    return <p className="bot-action-line" role="status"><span className="mini-spinner" aria-hidden="true" />{action.action === "start" ? copy.startingFor(secs) : copy.restartingFor(secs)}</p>;
  }
  if (action.kind === "done") return <p className="bot-action-line is-done" role="status">{copy.backOnline}</p>;
  if (action.kind === "error") return <p className="bot-action-line is-error" role="alert">{action.message}</p>;
  return null;
}

function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fast ? 1_000 : 30_000);
    return () => clearInterval(t);
  }, [fast]);
  return now;
}

interface PanelProps {
  info: BotInfoState;
  copy: Messages;
  planName: string;
  /** "Renews on …" / "Set to cancel…" line, when the plan is paid. */
  planNote: string | null;
  assistantName: string;
  needsPayment: boolean;
  channelsEnabled: boolean;
  byokEnabled: boolean;
  latestActivityAt: string | null;
  formatDate: (iso: string) => string;
  formatDateTime: (iso: string) => string;
  onOpen: (panel: "channels" | "modelKey" | "billing") => void;
}

interface ChannelRow { platform: string; paired: boolean }

export default function MyAssistantPanel(props: PanelProps) {
  const { info, copy, planName, planNote, assistantName, needsPayment, channelsEnabled, byokEnabled, latestActivityAt, formatDate, formatDateTime, onOpen } = props;
  const b = copy.bot;
  const { bot, loadError } = info;
  const now = useNow(info.action.kind === "working");
  // A failed check shows "Checking", never a stale "Running".
  const state: BotState = info.loadError ? "unknown" : bot?.state ?? "unknown";

  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  useEffect(() => {
    if (!channelsEnabled) return;
    let alive = true;
    fetch("/api/channels", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { channels?: ChannelRow[] } | null) => { if (alive) setChannels(Array.isArray(d?.channels) ? d!.channels : []); })
      .catch(() => { if (alive) setChannels([]); });
    return () => { alive = false; };
  }, [channelsEnabled]);

  const channelName = (id: string) => (copy.channelName as Record<string, string>)[id] ?? id;
  const used = formatBytes(bot?.diskUsedBytes ?? null);
  const limit = formatBytes(bot?.diskLimitBytes ?? null);
  const pct = bot?.diskUsedBytes != null && bot?.diskLimitBytes ? Math.min(100, Math.max(1, (bot.diskUsedBytes / bot.diskLimitBytes) * 100)) : 0;
  const memory = formatBytes(bot?.memoryBytes ?? null);

  return (
    <div className="control-content">
      <section className="control-heading">
        <span>{b.eyebrow}</span>
        <h1>{b.title}</h1>
        <p>{b.subtitle}</p>
      </section>

      {loadError && <p className="panel-error" role="alert">{b.loadError}</p>}
      {info.noInstance && (
        <section className="bot-hero">
          <div className="bot-hero-main">
            <p className="bot-state is-stopped"><i aria-hidden="true" />{b.notSetUp}</p>
          </div>
          {needsPayment && <button className="btn btn-primary" onClick={() => onOpen("billing")}>{b.choosePlan}</button>}
        </section>
      )}

      {!info.noInstance && (<>
      <section className="bot-hero">
        <div className="bot-hero-main">
          <p className={`bot-state is-${state}`}><i aria-hidden="true" />{b.state[state]}<span>· {b.stateHint[state]}</span></p>
          <h2>{assistantName}</h2>
          <p className="bot-meta">
            {[bot?.createdAt ? b.createdOn(formatDate(bot.createdAt)) : null, bot?.version ? b.versionLabel(bot.version) : null].filter(Boolean).join(" · ")}
          </p>
          <ActionLine info={info} copy={b} now={now} />
        </div>
        <ActionButtons info={info} copy={b} disabled={needsPayment} />
      </section>

      <section className="bot-tiles">
        <article>
          <span>{copy.planLabel}</span>
          <strong>{planName}</strong>
          {planNote ? <p>{planNote}</p> : needsPayment ? <button className="bot-link" onClick={() => onOpen("billing")}>{b.choosePlan}</button> : null}
        </article>
        <article>
          <span>{b.computerLabel}</span>
          <strong>{bot?.cpu && memory ? b.computerValue(bot.cpu, memory) : "—"}</strong>
          <p>{b.computerHint}</p>
        </article>
        <article>
          <span>{b.storageLabel}</span>
          <strong>{used ? (limit ? b.storageOf(used, limit) : used) : b.measuring}</strong>
          <div className="bot-meter" aria-hidden="true"><b style={{ width: `${pct}%` }} /></div>
        </article>
      </section>

      <section className="bot-details">
        <div>
          <span>{b.modelLabel}</span>
          <strong>{bot?.model ?? (state === "running" ? b.modelIncluded : b.modelWhenRunning)}</strong>
          {byokEnabled && <button className="bot-link" onClick={() => onOpen("modelKey")}>{b.changeModel}</button>}
        </div>
        {channelsEnabled && (
          <div>
            <span>{b.channelsLabel}</span>
            {channels === null ? (
              <strong className="is-muted">{b.checking}</strong>
            ) : channels.length === 0 ? (
              <strong className="is-muted">{b.noChannels}</strong>
            ) : (
              <p className="bot-chips">
                {channels.map((c) => (
                  <span key={c.platform} className={c.paired ? "" : "is-off"}><i aria-hidden="true" />{channelName(c.platform)}</span>
                ))}
              </p>
            )}
            <button className="bot-link" onClick={() => onOpen("channels")}>{b.connect}</button>
          </div>
        )}
        <div>
          <span>{b.onlineSinceLabel}</span>
          <strong>{bot?.startedAt && state === "running" ? formatDateTime(bot.startedAt) : b.notOnline}</strong>
          {bot?.startedAt && state === "running" && <p>{b.upFor(ago(bot.startedAt, now, b))}</p>}
        </div>
        <div>
          <span>{copy.latestActivity}</span>
          <strong>{latestActivityAt ? formatDateTime(latestActivityAt) : copy.noActivityYet}</strong>
        </div>
      </section>
      <p className="bot-footnote">{b.footnote}</p>
      </>)}
    </div>
  );
}

/** Option C: the compact card at the top of Usage. */
export function BotSummaryCard({ info, copy, planName, needsPayment, onOpen }: { info: BotInfoState; copy: Messages; planName: string; needsPayment: boolean; onOpen: () => void }) {
  const b = copy.bot;
  const { bot } = info;
  const now = useNow(info.action.kind === "working");
  // A failed check shows "Checking", never a stale "Running".
  const state: BotState = info.loadError ? "unknown" : bot?.state ?? "unknown";
  const memory = formatBytes(bot?.memoryBytes ?? null);
  const used = formatBytes(bot?.diskUsedBytes ?? null);
  if (info.noInstance) return null;
  return (
    <section className="bot-summary">
      <div className="bot-summary-state">
        <span>{b.summaryEyebrow}</span>
        <p className={`bot-state is-${state}`}><i aria-hidden="true" />{b.state[state]}</p>
        {bot?.version && <small>{b.versionLabel(bot.version)}</small>}
      </div>
      <div><span>{b.computerLabel}</span><strong>{bot?.cpu && memory ? `${planName} · ${b.computerValue(bot.cpu, memory)}` : planName}</strong></div>
      <div><span>{b.storageLabel}</span><strong>{used ?? b.measuring}</strong></div>
      <div><span>{b.modelLabel}</span><strong>{bot?.model ?? "—"}</strong></div>
      <div className="bot-summary-actions">
        <ActionButtons info={info} copy={b} disabled={needsPayment} />
        <button className="bot-link" onClick={onOpen}>{b.viewDetails}</button>
      </div>
      <ActionLine info={info} copy={b} now={now} />
    </section>
  );
}

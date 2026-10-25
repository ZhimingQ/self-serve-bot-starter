"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { messages as translations, type Locale } from "../../lib/i18n";
import LanguageSwitcher from "../LanguageSwitcher";
import DashboardIcon from "./DashboardIcon";
import { getCustomerPreset, type CustomerPresetId } from "../../lib/customerPresets";
import ChannelsPanel from "./ChannelsPanel";
import ModelKeyPanel from "./ModelKeyPanel";
import BotToolsPanel from "./BotToolsPanel";
import type { BotToolId } from "../../lib/botTools";
import {
  defaultAssistantPreferences,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  type AssistantPreferences,
  type StoredChatMessage,
} from "../../lib/customerWorkspace";
import SetupProgress from "./SetupProgress";
import ChatMarkdown from "./ChatMarkdown";
import WorkingIndicator from "./WorkingIndicator";

interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  error?: boolean;
  /** A reply cut off part-way: kept and formatted as usual, but offers Try again. */
  interrupted?: boolean;
}

// White-label: the end-user must never see the reseller's raw upstream error text
// (e.g. an account billing/plan message), so any turn failure collapses to this.
// A chat error whose `message` is SAFE to display verbatim (our own friendly copy).
// Anything thrown that is NOT this (raw fetch/stream exceptions) is shown as the
// generic line instead, so implementation details never reach the end-user.
class ChatDisplayError extends Error {}

type ProvisionState = "checking" | "provisioning" | "ready" | "error";
type Panel = "overview" | "assistant" | "channels" | "prompts" | "history" | "usage" | "notifications" | "billing" | "modelKey" | "botTools" | "settings" | "security" | "account" | "privacy" | "support";
/** The panels WORKSPACE_MODE=simple offers. Billing is listed but only shown
 *  when payments are on. */
const SIMPLE_PANELS: ReadonlySet<Panel> = new Set<Panel>(["assistant", "history", "billing", "account", "privacy", "support"]);
type AsyncStatus = "idle" | "working" | "done" | "error";
type WorkspaceLoadStatus = "loading" | "ready" | "error";

const POLL_INTERVAL_MS = 3000;
// Past this the bot is slower than usual, so back off and reassure — do NOT
// declare failure. A cold start that misses the 2-minute mark is still a
// perfectly healthy bot, and the customer's very first impression of the
// product should not be an error screen for something that is about to work.
// (Observed: a signup where the assistant came up fine while the storefront
// had already told the customer it went wrong.)
const SLOW_AFTER_ATTEMPTS = 40; // ~2 minutes at the fast interval
// The student website's setup steps (it is English only).
const STUDENT_SETUP_STEPS = ["Reserving your tutor", "Setting up web search", "Final checks"] as const;
const SLOW_POLL_INTERVAL_MS = 10000;
// The real giving-up point: ~2 min fast + ~10 min slow. Past this something is
// genuinely wrong and a retry button is the honest answer.
const MAX_POLL_ATTEMPTS = 100;

function summarizeSavedHistory(messages: StoredChatMessage[]) {
  return {
    userTurns: messages.filter((message) => message.role === "user" && message.content).length,
    assistantReplies: messages.filter(
      (message) => message.role === "assistant" && message.content && !message.error
    ).length,
    latestActivityAt: messages.reduce<string | null>((latest, message) => {
      if (!message.createdAt || !message.content) return latest;
      return !latest || new Date(message.createdAt) > new Date(latest) ? message.createdAt : latest;
    }, null),
  };
}

export default function ChatApp({
  email,
  paid,
  paymentsEnabled,
  billingMode,
  billingStatus: accountBillingStatus,
  accountCreatedAt,
  sessionStartedAt,
  sessionExpiresAt,
  locale,
  localeLocked,
  brandName,
  brandLogoUrl,
  brandWebsiteUrl,
  templateUrl,
  supportEmail,
  privacyUrl,
  termsUrl,
  byokEnabled = false,
  channelsEnabled = true,
  botTools = [],
  simpleMode = false,
  studentMode = false,
  turnsOutliveThePage = false,
  preview = false,
  customerPresetId = "general",
  previewHomeHref,
}: {
  email: string;
  paid: boolean;
  paymentsEnabled: boolean;
  billingMode: "subscription" | "payment" | "none";
  billingStatus: "active" | "canceled" | "none";
  accountCreatedAt: string | null;
  sessionStartedAt: string;
  sessionExpiresAt: string;
  locale: Locale;
  localeLocked: boolean;
  brandName: string;
  brandLogoUrl: string;
  brandWebsiteUrl: string;
  templateUrl: string;
  supportEmail: string;
  privacyUrl: string;
  termsUrl: string;
  /** ALLOW_END_USER_BYOK — the customer may fund the assistant with their own
   *  provider key. Off unless the reseller turns it on: it hands away the margin
   *  of anyone who resells model credits. */
  byokEnabled?: boolean;
  /** ALLOW_CHANNEL_CONNECT — the customer may connect messaging apps themselves. */
  channelsEnabled?: boolean;
  /** BOT_TOOLS — the per-assistant tools (power, backup, files, ...) this
   *  storefront offers its customers. Empty hides the Bot tools panel. */
  botTools?: BotToolId[];
  /** WORKSPACE_MODE=simple — "sign in and chat": the customer lands in the chat
   *  and only Chat, History, Account, Your data, Help (and Billing when payments
   *  are on) are offered. The server forces Channels, Model key and Bot tools off
   *  in this mode, so those arrive here already disabled. */
  simpleMode?: boolean;
  /** WORKSPACE_MODE=students — the chat becomes a study desk: a reminder of
   *  what the tutor will and won't do, starter chips, and "New question". Always
   *  arrives with simpleMode on. */
  studentMode?: boolean;
  /** The server keeps a chat turn running after the browser leaves (a single
   *  long-lived process; not a serverless host), so the page may say so. */
  turnsOutliveThePage?: boolean;
  preview?: boolean;
  customerPresetId?: CustomerPresetId;
  previewHomeHref?: string;
}) {
  const copy = translations[locale];
  const profile = !studentMode && customerPresetId !== "general" ? getCustomerPreset(customerPresetId)[locale] : null;
  const startingPrompts = profile?.prompts ?? [copy.promptOne, copy.promptTwo, copy.promptThree];
  const promptLibrary = profile ? profile.workflows.map((job) => [job.prompt, job.result, job.title]) : [
    [copy.promptOne, copy.promptOneBody, copy.promptCategoryPlan],
    [copy.promptTwo, copy.promptTwoBody, copy.promptCategoryWrite],
    [copy.promptThree, copy.promptThreeBody, copy.promptCategoryThink],
    [copy.promptFour, copy.promptFourBody, copy.promptCategorySummarize],
    [copy.promptFive, copy.promptFiveBody, copy.promptCategoryCreate],
    [copy.promptSix, copy.promptSixBody, copy.promptCategoryDecide],
  ];
  const router = useRouter();
  const needsPayment = paymentsEnabled && !paid;
  const [provisionState, setProvisionState] = useState<ProvisionState>(preview ? "ready" : "checking");
  const [provisionError, setProvisionError] = useState<string | null>(null);
  // A FLAG, not the localized string: provisioning can outlast a language
  // switch, and storing the text would leave the note in the old language.
  const [provisionSlow, setProvisionSlow] = useState(false);
  // A returning customer's first status check answers in well under a second;
  // only past this delay does the full setup screen replace a brief "opening".
  const [checkingLong, setCheckingLong] = useState(false);
  // One clock for the whole setup, so the progress does not restart when the
  // first check hands over to polling.
  const [setupStartedAt, setSetupStartedAt] = useState(() => Date.now());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("assistant");
  // Every navigation goes through here. In simple mode a link to a panel that
  // mode does not offer (an overview tile, "browse prompts", ...) lands on the
  // chat instead of opening a page the reseller chose to hide. A feature the
  // owner switched on explicitly (Channels, Model key, Bot tools) is offered.
  const openPanel = useCallback(
    (next: Panel) => {
      const switchedOn =
        (next === "channels" && channelsEnabled) ||
        (next === "modelKey" && byokEnabled) ||
        (next === "botTools" && botTools.length > 0);
      setPanel(simpleMode && !SIMPLE_PANELS.has(next) && !switchedOn ? "assistant" : next);
    },
    [simpleMode, channelsEnabled, byokEnabled, botTools.length]
  );
  const [sessionUserTurns, setSessionUserTurns] = useState(0);
  const [sessionAssistantReplies, setSessionAssistantReplies] = useState(0);
  const [savedUserTurns, setSavedUserTurns] = useState(0);
  const [savedAssistantReplies, setSavedAssistantReplies] = useState(0);
  const [savedLatestActivityAt, setSavedLatestActivityAt] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<AssistantPreferences>({ ...defaultAssistantPreferences });
  const [preferencesDraft, setPreferencesDraft] = useState<AssistantPreferences>({ ...defaultAssistantPreferences });
  const [preferencesStatus, setPreferencesStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [billingStatus, setBillingStatus] = useState<"idle" | "opening" | "error">("idle");
  const [workspaceLoadStatus, setWorkspaceLoadStatus] = useState<WorkspaceLoadStatus>(preview ? "ready" : "loading");
  const [downloadStatus, setDownloadStatus] = useState<AsyncStatus>("idle");
  const [clearStatus, setClearStatus] = useState<AsyncStatus>("idle");
  const [deleteStatus, setDeleteStatus] = useState<AsyncStatus>("idle");
  const [logoutStatus, setLogoutStatus] = useState<"idle" | "working" | "error">("idle");
  const [sessionStatus, setSessionStatus] = useState<AsyncStatus>("idle");
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmNewTopic, setConfirmNewTopic] = useState(false);
  const [newTopicStatus, setNewTopicStatus] = useState<AsyncStatus>("idle");
  const assistantInputRef = useRef<HTMLTextAreaElement>(null);
  // A turn taking a while shows a "still working" note; a turn found running on
  // load (the page was reloaded mid-answer) is waited for until it lands.
  const [slowTurn, setSlowTurn] = useState(false);
  const [resumedTurn, setResumedTurn] = useState(false);
  const resumedTurnRef = useRef<{ input: string; startedAt: string } | null>(null);
  // True while this tab's own send is in flight, so its turn is never mistaken
  // for one to resume.
  const localSendRef = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const hasLocalActivityRef = useRef(false);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const mainContentRef = useRef<HTMLElement>(null);
  const panelInitializedRef = useRef(false);
  // The provisioning poll re-arms itself for up to ~12 minutes. Without a
  // handle, unmounting (or a Strict Mode double-invoke) leaves a second chain
  // running that can overwrite a settled "ready" back to "provisioning".
  const provisionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation counter for the poll. Cancelling the pending TIMER is not
  // enough: a poll already awaiting its fetch resumes afterwards and would
  // happily schedule a fresh chain or overwrite a settled state. Each run
  // captures its generation and abandons itself once it is no longer current.
  const provisionRunRef = useRef(0);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  // Cancel a pending poll on unmount so a re-armed chain cannot outlive the
  // component and resurrect a stale provisioning state.
  useEffect(() => () => {
    provisionRunRef.current += 1;
    if (provisionTimerRef.current) clearTimeout(provisionTimerRef.current);
  }, []);

  const loadWorkspace = useCallback(async (signal?: AbortSignal) => {
    if (preview) return;
    setWorkspaceLoadStatus("loading");
    try {
      const [historyResponse, preferenceResponse] = await Promise.all([
        fetch("/api/history", { cache: "no-store", signal }),
        fetch("/api/preferences", { cache: "no-store", signal }),
      ]);
      if (!historyResponse.ok || !preferenceResponse.ok) throw new Error("workspace_load_failed");
      const [historyData, preferenceData] = await Promise.all([
        historyResponse.json(),
        preferenceResponse.json(),
      ]);
      if (Array.isArray(historyData.messages)) {
        const storedMessages = historyData.messages as StoredChatMessage[];
        const usage = summarizeSavedHistory(storedMessages);
        if (!hasLocalActivityRef.current) {
          // Reloaded mid-answer: show the question and wait for the reply.
          if (localSendRef.current || !showRunningTurn(storedMessages, historyData.working)) {
            setMessages(storedMessages);
          }
        }
        setSavedUserTurns(usage.userTurns);
        setSavedAssistantReplies(usage.assistantReplies);
        setSavedLatestActivityAt(usage.latestActivityAt);
      }
      const next = preferenceData.preferences ?? defaultAssistantPreferences;
      setPreferences(next);
      setPreferencesDraft(next);
      setWorkspaceLoadStatus("ready");
    } catch (error) {
      if ((error as Error).name !== "AbortError") setWorkspaceLoadStatus("error");
    }
  }, [preview]);

  /** Shows a turn the server is still working on (after a reload, or when this
   *  tab's stream dropped) and starts waiting for it. False when there is none,
   *  or when the history already holds it (it finished as history was read). */
  function showRunningTurn(storedMessages: StoredChatMessage[], working: unknown): boolean {
    const turn = working as { input?: unknown; startedAt?: unknown } | null | undefined;
    if (!turn || typeof turn.input !== "string" || typeof turn.startedAt !== "string") return false;
    const { input: turnInput, startedAt } = turn as { input: string; startedAt: string };
    if (storedMessages.some((m) => m.role === "user" && m.createdAt === startedAt)) return false;
    setMessages([
      ...storedMessages,
      { role: "user", content: turnInput, createdAt: startedAt },
      { role: "assistant", content: "", createdAt: startedAt },
    ]);
    resumedTurnRef.current = { input: turnInput, startedAt };
    setSending(true);
    setSlowTurn(true);
    setResumedTurn(true);
    return true;
  }

  /** This tab's stream failed: if the server is still on the turn, wait for it;
   *  if it already saved the answer to `sentInput`, show it. The composer stays
   *  locked (sending) until this settles, so no newer turn can be overwritten. */
  async function resumeIfStillWorking(sentInput: string, savedActivityBefore: string | null) {
    try {
      const response = await fetch("/api/history", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.messages)) return;
      const storedMessages = data.messages as StoredChatMessage[];
      if (showRunningTurn(storedMessages, data.working)) return;
      // Saved meanwhile: show it, but only if it is a NEW question (a repeat of
      // an earlier identical one must not stand in for a send that failed).
      const usageNow = summarizeSavedHistory(storedMessages);
      const lastQuestion = [...storedMessages].reverse().find((m) => m.role === "user");
      const isNew = !!lastQuestion?.createdAt &&
        (!savedActivityBefore || new Date(lastQuestion.createdAt) > new Date(savedActivityBefore));
      if (!data.working && isNew && lastQuestion?.content === sentInput) {
        setMessages(storedMessages);
        setSavedUserTurns(usageNow.userTurns);
        setSavedAssistantReplies(usageNow.assistantReplies);
        setSavedLatestActivityAt(usageNow.latestActivityAt);
      }
    } catch {
      // Nothing more to do: the error is already on screen.
    } finally {
      if (!resumedTurnRef.current) setSending(false);
    }
  }

  // After a reload mid-turn, wait for the server to finish the turn and then
  // show the saved conversation, reply included.
  useEffect(() => {
    if (!resumedTurn || preview) return;
    let stopped = false;
    // A turn that ended without its reply saved is reported only after a few
    // checks in a row, so one answer from a server that cannot see the turn
    // (a host running several copies) is not taken for a failure.
    let unsavedChecks = 0;
    const poll = async () => {
      if (stopped) return;
      try {
        const response = await fetch("/api/history", { cache: "no-store" });
        if (response.status === 401) {
          // Signed out meanwhile: stop waiting and let the page re-check the session.
          setResumedTurn(false);
          setSlowTurn(false);
          setSending(false);
          router.refresh();
          return;
        }
        if (response.ok) {
          const data = await response.json();
          if (data.working) unsavedChecks = 0;
          if (!stopped && !data.working && Array.isArray(data.messages)) {
            const storedMessages = data.messages as StoredChatMessage[];
            const usage = summarizeSavedHistory(storedMessages);
            // A turn that ended without a reply saves nothing; keep the question
            // and say so instead of letting it vanish.
            const pending = resumedTurnRef.current;
            const saved = pending && storedMessages.some((m) => m.role === "user" && m.createdAt === pending.startedAt);
            if (pending && !saved && ++unsavedChecks < 3) {
              timer = window.setTimeout(poll, 5000);
              return;
            }
            setMessages(
              pending && !saved
                ? [
                    ...storedMessages,
                    { role: "user", content: pending.input, createdAt: pending.startedAt },
                    { role: "assistant", content: copy.chatError, createdAt: pending.startedAt, error: true },
                  ]
                : storedMessages
            );
            setSavedUserTurns(usage.userTurns);
            setSavedAssistantReplies(usage.assistantReplies);
            setSavedLatestActivityAt(usage.latestActivityAt);
            resumedTurnRef.current = null;
            setResumedTurn(false);
            setSlowTurn(false);
            setSending(false);
            return;
          }
        }
      } catch {
        // Try again on the next tick.
      }
      if (!stopped) timer = window.setTimeout(poll, 5000);
    };
    let timer = window.setTimeout(poll, 5000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [resumedTurn, preview, router, copy.chatError]);

  // Keep the composer's height in step with its text, including the clear after send.
  useEffect(() => {
    fitComposer(assistantInputRef.current);
  }, [input]);

  const refreshSavedUsage = useCallback(async () => {
    if (preview) return;
    try {
      const response = await fetch("/api/history", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.messages)) return;
      const usage = summarizeSavedHistory(data.messages as StoredChatMessage[]);
      setSavedUserTurns(usage.userTurns);
      setSavedAssistantReplies(usage.assistantReplies);
      setSavedLatestActivityAt(usage.latestActivityAt);
    } catch {
      // Keep the last authoritative totals if the refresh is temporarily unavailable.
    }
  }, [preview]);

  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    void loadWorkspace(controller.signal);
    return () => controller.abort();
  }, [loadWorkspace, preview]);

  const startCheckout = useCallback(async () => {
    if (subscribing) return;
    setSubscribing(true);
    setSubscribeError(null);
    try {
      const res = await fetch("/api/checkout", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      if (res.ok && data.alreadyPaid) {
        router.refresh();
        return;
      }
      setSubscribeError(copy.checkoutError);
    } catch {
      setSubscribeError(copy.checkoutError);
    }
    setSubscribing(false);
  }, [subscribing, router, copy.checkoutError]);

  const provision = useCallback(async () => {
    // A retry must replace the running chain, not race it.
    if (provisionTimerRef.current) clearTimeout(provisionTimerRef.current);
    const run = ++provisionRunRef.current;
    const stale = () => run !== provisionRunRef.current;
    let attempts = 0;
    setProvisionSlow(false);
    setSetupStartedAt(Date.now());

    const poll = async (): Promise<void> => {
      if (stale()) return;
      attempts += 1;
      try {
        const res = await fetch("/api/provision", { method: "POST" });
        const data = await res.json();
        // Superseded while the request was in flight.
        if (stale()) return;

        if (!res.ok) {
          setProvisionError(
            data?.error === "storefront_unavailable"
              ? copy.storefrontUnavailable
              : copy.provisionFailed
          );
          setProvisionState("error");
          return;
        }

        if (data.status === "running") {
          setProvisionSlow(false);
          setProvisionState("ready");
          return;
        }

        if (attempts >= MAX_POLL_ATTEMPTS) {
          setProvisionError(
            copy.provisionSlow
          );
          setProvisionState("error");
          return;
        }

        setProvisionState("provisioning");
        // Still starting, just slower than usual: say so and keep waiting
        // rather than flipping to an error the customer has to recover from.
        const slow = attempts >= SLOW_AFTER_ATTEMPTS;
        setProvisionSlow(slow);
        provisionTimerRef.current = setTimeout(poll, slow ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
      } catch {
        if (stale()) return;
        setProvisionError(copy.serverUnavailable);
        setProvisionState("error");
      }
    };

    await poll();
  }, [copy.provisionFailed, copy.provisionSlow, copy.serverUnavailable, copy.storefrontUnavailable]);

  useEffect(() => {
    if (provisionState !== "checking") return;
    const timer = window.setTimeout(() => setCheckingLong(true), 1500);
    return () => window.clearTimeout(timer);
  }, [provisionState]);

  useEffect(() => {
    // Only provision once the user is entitled — a paywalled user provisions
    // after they pay (Stripe redirects back to /app?paid=1 → server passes
    // paid=true → this effect runs).
    if (!preview && !needsPayment) provision();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPayment]);

  useEffect(() => {
    const container = chatMessagesRef.current;
    container?.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    // Also when the chat first appears: history often loads while the setup
    // screen is still up, before this container exists.
  }, [messages, provisionState, panel]);

  useEffect(() => {
    if (panelInitializedRef.current) {
      mainContentRef.current?.focus({ preventScroll: true });
    } else {
      panelInitializedRef.current = true;
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [panel]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(`workspace-notifications:${email.toLowerCase()}`);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setReadNotificationIds(parsed.filter((id): id is string => typeof id === "string"));
        }
      }
    } catch {
      // Private browsing or storage policies can disable localStorage.
    }
  }, [email]);

  async function handleLogout() {
    setLogoutStatus("working");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error();
      router.push("/");
      router.refresh();
    } catch {
      setLogoutStatus("error");
    }
  }

  async function revokeOtherSessions() {
    setSessionStatus("working");
    if (preview) {
      window.setTimeout(() => setSessionStatus("done"), 350);
      return;
    }
    try {
      const response = await fetch("/api/account/sessions", { method: "POST" });
      if (!response.ok) throw new Error();
      setSessionStatus("done");
    } catch {
      setSessionStatus("error");
    }
  }

  function handleSend(event: React.FormEvent) {
    event.preventDefault();
    void sendText(input);
  }

  /** A failed reply's "Try again": ask the same question once more, in place of
   *  the failed pair, so the student never has to retype it. */
  function retryLastQuestion() {
    if (sending || newTopicStatus === "working") return;
    const last = messages[messages.length - 1];
    const question = messages[messages.length - 2];
    if (!(last?.error || last?.interrupted) || question?.role !== "user") return;
    setMessages((prev) => prev.slice(0, -2));
    void sendText(question.content);
  }

  /** Only the newest bubble, only when it failed and follows the question. */
  function canRetry(index: number) {
    return !sending && newTopicStatus !== "working" && index === messages.length - 1
      && Boolean(messages[index]?.error || messages[index]?.interrupted) && messages[index - 1]?.role === "user";
  }

  async function sendText(text: string) {
    const trimmed = text.trim();
    // Not while "New question" is clearing the conversation: the turn would go
    // to the old conversation and then be wiped from the screen.
    if (!trimmed || sending || newTopicStatus === "working") return;

    hasLocalActivityRef.current = true;
    setInput("");
    const createdAt = new Date().toISOString();
    setMessages((prev) => [...prev, { role: "user", content: trimmed, createdAt }]);
    setMessages((prev) => [...prev, { role: "assistant", content: "", createdAt }]);
    setSessionUserTurns((count) => count + 1);
    setSending(true);

    if (preview) {
      window.setTimeout(() => {
        setLastAssistantMessage(setMessages, copy.demoChatResponse);
        setSessionAssistantReplies((count) => count + 1);
        setSavedUserTurns((count) => count + 1);
        setSavedAssistantReplies((count) => count + 1);
        setSavedLatestActivityAt(createdAt);
        setSending(false);
      }, 450);
      return;
    }

    let gotContent = false; // did the assistant stream any actual reply text?
    // The connection failed, or a turn is already running: the server may
    // still be answering, so look for it once this send has cleaned up.
    let checkServer = false;
    // Server time of the newest saved message before this send; a saved question
    // newer than it can only be this one.
    const savedActivityBefore = savedLatestActivityAt;
    const slowTimer = window.setTimeout(() => setSlowTurn(true), 20_000);

    localSendRef.current = true;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });

      if (!res.ok || !res.body) {
        if (res.status === 409) {
          // Refused (another turn or a clear is running): hand the question
          // back so it can be sent once that is done.
          checkServer = true;
          setInput((current) => current || trimmed);
        }
        // Our own API errors carry a friendly `message` (402 pay, 429 slow down,
        // 413 too long) — show ONLY that (never `data.error`, which can be a raw
        // code/text). Anything else collapses to the generic line.
        const known = res.status === 402 || res.status === 429 || res.status === 413 || res.status === 409;
        throw new ChatDisplayError(
          known ? localizedChatError(res.status, locale, copy) : copy.chatError
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamErrored = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine.startsWith("data:")) continue;

          const payload = trimmedLine.slice(5).trim();
          if (payload === "[DONE]") continue;

          try {
            const parsed = JSON.parse(payload);
            // Upstream surfaces a mid-turn failure as { error }. Without this the
            // turn dies silently and the bubble hangs on the "…" typing dots.
            if (parsed?.error) {
              streamErrored = true;
              // Keep draining the response so the server's stream flush can
              // finish its authoritative history write before usage refreshes.
              continue;
            }
            if (streamErrored) continue;
            const delta: string | undefined = parsed?.choices?.[0]?.delta?.content;
            if (delta) {
              gotContent = true;
              appendToLastAssistantMessage(setMessages, delta);
            }
          } catch {
            // ignore malformed/keep-alive chunks
          }
        }
      }

      // The stream ended (or errored) with no reply, OR was interrupted after a
      // partial reply — surface it instead of leaving an empty/spinning bubble.
      if (!gotContent) {
        setLastAssistantMessage(setMessages, copy.chatError, true);
      } else if (streamErrored) {
        appendToLastAssistantMessage(setMessages, `\n\n${copy.interrupted}`, true);
        await refreshSavedUsage();
      } else {
        setSessionAssistantReplies((count) => count + 1);
        // Read back the server-owned history after its stream flush so usage
        // never labels an optimistic or failed browser turn as persisted.
        await refreshSavedUsage();
      }
    } catch (err) {
      // Only our own ChatDisplayError carries a message safe to show; any other
      // thrown value (raw fetch/stream exception) collapses to the generic line.
      const msg = err instanceof ChatDisplayError ? err.message : copy.chatError;
      if (!(err instanceof ChatDisplayError)) checkServer = true;
      // If a partial reply already streamed, keep it and add the interrupted note;
      // otherwise replace the empty placeholder bubble with the error message.
      if (gotContent) {
        appendToLastAssistantMessage(setMessages, `\n\n${copy.interrupted}`, true);
      } else {
        setLastAssistantMessage(setMessages, msg, true);
      }
    } finally {
      window.clearTimeout(slowTimer);
      localSendRef.current = false;
      setSlowTurn(false);
      if (!checkServer) setSending(false);
    }
    if (checkServer) void resumeIfStillWorking(trimmed, savedActivityBefore);
  }

  async function savePreferences(event: React.FormEvent) {
    event.preventDefault();
    if (workspaceLoadStatus !== "ready") return;
    setPreferencesStatus("saving");
    if (preview) {
      setPreferences(preferencesDraft);
      setPreferencesStatus("saved");
      return;
    }
    try {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferencesDraft),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setPreferences(data.preferences);
      setPreferencesDraft(data.preferences);
      setPreferencesStatus("saved");
    } catch { setPreferencesStatus("error"); }
  }

  async function openBillingPortal() {
    setBillingStatus("opening");
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error();
      window.location.href = data.url;
    } catch { setBillingStatus("error"); }
  }

  async function downloadData() {
    setDownloadStatus("working");
    try {
      let blob: Blob;
      if (preview) {
        blob = new Blob([JSON.stringify({
          exportedAt: new Date().toISOString(),
          scope: "Preview customer workspace data",
          account: { email, accessStatus: "preview", billingMode: "none" },
          assistantPreferences: preferences,
          conversationHistory: messages.filter((message) => message.content),
        }, null, 2)], { type: "application/json" });
      } else {
        const res = await fetch("/api/account/export", { cache: "no-store" });
        if (!res.ok) throw new Error();
        blob = await res.blob();
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "customer-workspace-data.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setDownloadStatus("done");
    } catch { setDownloadStatus("error"); }
  }

  async function clearHistory() {
    if (sending) return;
    if (!confirmClear) { setClearStatus("idle"); setConfirmClear(true); return; }
    setClearStatus("working");
    try {
      if (!preview) {
        const res = await fetch("/api/history", { method: "DELETE" });
        if (!res.ok) throw new Error();
      }
      setMessages([]);
      setSessionUserTurns(0);
      setSessionAssistantReplies(0);
      setSavedUserTurns(0);
      setSavedAssistantReplies(0);
      setSavedLatestActivityAt(null);
      setConfirmClear(false);
      setClearStatus("done");
    } catch { setClearStatus("error"); }
  }

  // Student "New question": the tutor keeps one conversation, so starting a
  // new topic clears it (after an inline confirm — never window.confirm).
  async function startNewTopic() {
    if (sending) return;
    if (messages.length === 0) { assistantInputRef.current?.focus(); return; }
    if (!confirmNewTopic) { setNewTopicStatus("idle"); setConfirmNewTopic(true); return; }
    setNewTopicStatus("working");
    try {
      if (!preview) {
        const res = await fetch("/api/history", { method: "DELETE" });
        if (!res.ok) throw new Error();
      }
      setMessages([]);
      setSessionUserTurns(0);
      setSessionAssistantReplies(0);
      setSavedUserTurns(0);
      setSavedAssistantReplies(0);
      setSavedLatestActivityAt(null);
      setConfirmNewTopic(false);
      setNewTopicStatus("idle");
      assistantInputRef.current?.focus();
    } catch { setNewTopicStatus("error"); }
  }

  function startWith(prefix: string) {
    setInput(prefix);
    window.setTimeout(() => {
      const field = assistantInputRef.current;
      if (!field) return;
      fitComposer(field);
      field.focus();
      field.setSelectionRange(prefix.length, prefix.length);
    }, 0);
  }

  async function deleteAccount() {
    if (!confirmDelete) {
      setDeleteStatus("idle");
      setConfirmDelete(true);
      return;
    }
    if (deleteConfirmation.trim().toLowerCase() !== email.toLowerCase()) return;
    setDeleteStatus("working");
    if (preview) {
      window.setTimeout(() => setDeleteStatus("done"), 350);
      return;
    }
    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: deleteConfirmation }),
      });
      if (!response.ok) throw new Error();
      window.location.assign("/");
    } catch {
      setDeleteStatus("error");
    }
  }

  function openPrompt(prompt: string) {
    setInput(prompt);
    openPanel("assistant");
  }

  function markNotificationsRead(ids: string[]) {
    setReadNotificationIds(ids);
    try {
      window.localStorage.setItem(
        `workspace-notifications:${email.toLowerCase()}`,
        JSON.stringify(ids)
      );
    } catch {
      // The notification center still works for this page view without storage.
    }
  }

  if (needsPayment) {
    return (
      <div className="provisioning">
        <LanguageSwitcher locale={locale} locked={localeLocked} previewPreset={preview && !studentMode ? customerPresetId : undefined} />
        <h2>{copy.activateTitle}</h2>
        <p>{copy.activateBody(email.split("@")[0])}</p>
        {subscribeError && <p style={{ color: "#dc2626" }}>{subscribeError}</p>}
        <button className="btn btn-primary" onClick={startCheckout} disabled={subscribing}>
          {subscribing ? copy.redirecting : copy.subscribe}
        </button>
        <button
          className="btn btn-secondary"
          onClick={handleLogout}
          style={{ marginTop: 10 }}
        >
          {copy.logout}
        </button>
      </div>
    );
  }

  if (provisionState === "checking" && !checkingLong) {
    // A returning customer's bot already exists: say "opening", not "setting up".
    return (
      <div className="provisioning" role="status">
        <div className="spinner" />
        <LanguageSwitcher locale={locale} locked={localeLocked} previewPreset={preview && !studentMode ? customerPresetId : undefined} />
        <p>{studentMode ? "Opening your study desk…" : copy.openingWorkspace}</p>
      </div>
    );
  }

  if (provisionState === "checking" || provisionState === "provisioning") {
    const setupTitle = studentMode ? "Setting up your tutor" : copy.provisioningTitle;
    return (
      <div className="provisioning" role="status" aria-live="polite">
        <LanguageSwitcher locale={locale} locked={localeLocked} previewPreset={preview && !studentMode ? customerPresetId : undefined} />
        <h2>{setupTitle}</h2>
        <p>{copy.provisioningBody(email.split("@")[0])}</p>
        <SetupProgress
          label={setupTitle}
          steps={studentMode ? STUDENT_SETUP_STEPS : copy.provisioningSteps}
          startedAt={setupStartedAt}
        />
        {provisionSlow && <p className="muted">{copy.provisionStillWorking}</p>}
      </div>
    );
  }

  if (provisionState === "error") {
    return (
      <div className="provisioning">
        <LanguageSwitcher locale={locale} locked={localeLocked} previewPreset={preview && !studentMode ? customerPresetId : undefined} />
        <h2>{copy.wentWrong}</h2>
        <p>{provisionError}</p>
        <button className="btn btn-primary" onClick={() => provision()}>
          {copy.tryAgain}
        </button>
      </div>
    );
  }

  const displayName = preview ? copy.demoAccount : email.split("@")[0];
  const planName = preview
    ? copy.demoPlan
    : paymentsEnabled
      ? copy.planSubscription
      : copy.planIncluded;
  const userTurns = sessionUserTurns;
  const assistantReplies = sessionAssistantReplies;
  const savedTurns = savedUserTurns;
  const savedReplies = savedAssistantReplies;
  const latestActivityAt = savedLatestActivityAt;
  const billingStateLabel = billingMode === "subscription"
    ? accountBillingStatus === "active" ? copy.billingStatusActive : copy.billingStatusInactive
    : billingMode === "payment" ? copy.billingStatusOneTime : copy.billingStatusIncluded;
  const notificationItems = [
    {
      id: `workspace:${workspaceLoadStatus}`,
      icon: workspaceLoadStatus === "loading" ? "…" : workspaceLoadStatus === "error" ? "!" : "✓",
      title: workspaceLoadStatus === "loading"
        ? copy.notificationSyncLoadingTitle
        : workspaceLoadStatus === "error"
          ? copy.notificationSyncErrorTitle
          : copy.notificationSyncReadyTitle,
      body: workspaceLoadStatus === "loading"
        ? copy.notificationSyncLoadingBody
        : workspaceLoadStatus === "error"
          ? copy.notificationSyncErrorBody
          : copy.notificationSyncReadyBody,
    },
    {
      id: `history:${savedTurns}:${savedReplies}`,
      icon: "↻",
      title: savedTurns > 0 ? copy.notificationHistoryTitle : copy.notificationEmptyHistoryTitle,
      body: savedTurns > 0 ? copy.notificationHistoryBody(savedTurns, savedReplies) : copy.notificationEmptyHistoryBody,
    },
    {
      id: `billing:${billingMode}:${accountBillingStatus}`,
      icon: "$",
      title: copy.notificationAccessTitle,
      body: copy.notificationAccessBody(billingStateLabel),
    },
  ];
  const unreadNotifications = notificationItems.filter(
    (item) => !readNotificationIds.includes(item.id)
  ).length;
  // Channels sits in WORKSPACE because it is something the customer uses; the
  // model key sits in MANAGE because it is account plumbing. Both are omitted
  // entirely when the reseller has not enabled them — an item that 404s on click
  // is worse than no item.
  const fullPrimaryNav: { panel: Panel; label: string; icon: string }[] = [
    { panel: "assistant", label: copy.controlAssistant, icon: "✦" },
    ...(channelsEnabled ? [{ panel: "channels" as Panel, label: copy.controlChannels, icon: "◈" }] : []),
    ...(botTools.length > 0 ? [{ panel: "botTools" as Panel, label: copy.botTools.navLabel, icon: "▤" }] : []),
    { panel: "history", label: copy.controlHistory, icon: "↻" },
    { panel: "usage", label: copy.controlUsage, icon: "◫" },
  ];
  const fullManageNav: { panel: Panel; label: string; icon: string }[] = [
    { panel: "billing", label: copy.controlBilling, icon: "$" },
    ...(byokEnabled ? [{ panel: "modelKey" as Panel, label: copy.controlModelKey, icon: "⚿" }] : []),
    { panel: "security", label: copy.controlSecurity, icon: "◇" },
    { panel: "account", label: copy.controlAccount, icon: "○" },
    { panel: "privacy", label: copy.controlPrivacy, icon: "⌁" },
    { panel: "support", label: copy.controlSupport, icon: "?" },
  ];
  // Simple mode: the chat and the few things a customer must still be able to
  // reach — their saved history, their account, their data (download / delete)
  // and help. Billing appears only when there is something to pay.
  // A feature the owner switched on explicitly shows here too.
  const primaryNav: { panel: Panel; label: string; icon: string }[] = simpleMode
    ? [
        { panel: "assistant", label: studentMode ? "Study desk" : copy.controlAssistant, icon: "✦" },
        ...(channelsEnabled ? [{ panel: "channels" as Panel, label: copy.controlChannels, icon: "◈" }] : []),
        { panel: "history", label: copy.controlHistory, icon: "↻" },
      ]
    : fullPrimaryNav;
  const manageNav: { panel: Panel; label: string; icon: string }[] = simpleMode
    ? [
        ...(paymentsEnabled ? [{ panel: "billing" as Panel, label: copy.controlBilling, icon: "$" }] : []),
        ...(byokEnabled ? [{ panel: "modelKey" as Panel, label: copy.controlModelKey, icon: "⚿" }] : []),
        ...(botTools.length > 0 ? [{ panel: "botTools" as Panel, label: copy.botTools.navLabel, icon: "▤" }] : []),
        { panel: "account", label: copy.controlAccount, icon: "○" },
        { panel: "privacy", label: copy.controlPrivacy, icon: "⌁" },
        { panel: "support", label: copy.controlSupport, icon: "?" },
      ]
    : fullManageNav;
  const utilityNav: { panel: Panel; label: string }[] = simpleMode ? [] : [
    { panel: "overview", label: copy.controlOverview },
    { panel: "prompts", label: copy.controlPrompts },
    { panel: "notifications", label: copy.controlNotifications },
    { panel: "settings", label: copy.controlSettings },
  ];
  const allNav = [...primaryNav, ...manageNav, ...utilityNav];
  const currentPanelTitle = allNav.find(
    (item) => item.panel === panel
  )?.label;
  const supportHref = supportEmail
    ? `mailto:${supportEmail}?subject=${encodeURIComponent(copy.supportEmailSubject)}&body=${encodeURIComponent(copy.supportEmailBody(email))}`
    : "";

  return (
    <div className={`control-shell${studentMode ? "" : " customer-dashboard"}${panel === "assistant" && !studentMode ? " is-chat" : ""}`}>
      <a className="skip-link" href="#control-content">{copy.skipToContent}</a>
      <aside className="control-sidebar">
        {brandWebsiteUrl ? <a className="control-brand" href={brandWebsiteUrl} target="_blank" rel="noopener noreferrer">
          {brandLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brandLogoUrl} alt="" />
          ) : <span aria-hidden="true" />}
          <strong>{brandName}</strong>
        </a> : <div className="control-brand">
          {brandLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brandLogoUrl} alt="" />
          ) : <span aria-hidden="true" />}
          <strong>{brandName}</strong>
        </div>}

        <nav className="control-nav" aria-label={copy.navigationLabel}>
          <span className="control-nav-label">{copy.workspaceNavLabel}</span>
          {primaryNav.map((item) => (
            <button
              key={item.panel}
              className={panel === item.panel ? "active" : ""}
              aria-current={panel === item.panel ? "page" : undefined}
              onClick={() => openPanel(item.panel)}
            >
              <span aria-hidden="true">{studentMode ? item.icon : <DashboardIcon name={item.panel} />}</span>{item.label}
              {item.panel === "history" && savedTurns > 0 && <b>{savedTurns}</b>}
              {item.panel === "notifications" && unreadNotifications > 0 && <b aria-label={copy.unreadCount(unreadNotifications)}>{unreadNotifications}</b>}
            </button>
          ))}
          <span className="control-nav-label control-nav-manage">{copy.manageNavLabel}</span>
          {manageNav.map((item) => (
            <button
              key={item.panel}
              className={panel === item.panel ? "active" : ""}
              aria-current={panel === item.panel ? "page" : undefined}
              onClick={() => openPanel(item.panel)}
            >
              <span aria-hidden="true">{studentMode ? item.icon : <DashboardIcon name={item.panel} />}</span>{item.label}
            </button>
          ))}
        </nav>

        <div className="control-sidebar-account">
          <span>{copy.signedInAs}</span>
          <strong>{displayName}</strong>
          {!studentMode && <small>{billingStateLabel}</small>}
          {preview && <em>{copy.previewMode}</em>}
        </div>
      </aside>

      <main
        className="control-main"
        id="control-content"
        ref={mainContentRef}
        tabIndex={-1}
        aria-busy={workspaceLoadStatus === "loading"}
      >
        <header className="control-topbar">
          <div>
            <span>{studentMode ? brandName : profile?.name ?? copy.workspace}</span>
            {panel === "assistant" && !studentMode ? <h1>{currentPanelTitle}</h1> : <strong>{currentPanelTitle}</strong>}
          </div>
          <div className="control-topbar-actions">
            {preview && previewHomeHref && <a className="text-link" href={previewHomeHref}>{copy.website}</a>}
            <span className={`control-live ${workspaceLoadStatus === "error" ? "is-error" : ""}`} role="status">
              {workspaceLoadStatus === "loading" ? <span className="mini-spinner" aria-hidden="true" /> : <i />}
              {workspaceLoadStatus === "loading" ? copy.syncingWorkspace : workspaceLoadStatus === "error" ? copy.syncFailed : copy.onlineNow}
            </span>
            <LanguageSwitcher locale={locale} locked={localeLocked} previewPreset={preview && !studentMode ? customerPresetId : undefined} />
            {utilityNav.length > 0 && (
              <details className="dashboard-more" onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary")?.focus();
                }
              }}>
                <summary><DashboardIcon name="more" /><span>{copy.moreTools}</span></summary>
                <div className="dashboard-more-items">
                  {utilityNav.map((item) => (
                    <button key={item.panel} type="button" aria-current={panel === item.panel ? "page" : undefined}
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        openPanel(item.panel);
                      }}>
                      <DashboardIcon name={item.panel} /><span>{item.label}</span>
                      {item.panel === "notifications" && unreadNotifications > 0 && <b aria-label={copy.unreadCount(unreadNotifications)}>{unreadNotifications}</b>}
                    </button>
                  ))}
                </div>
              </details>
            )}
          </div>
        </header>

        <label className="control-mobile-nav">
          <span>{studentMode ? "Go to" : copy.mobileNavigationLabel}</span>
          <select id="control-mobile-section" name="control-section" value={panel} onChange={(event) => openPanel(event.target.value as Panel)}>
            {allNav.map((item) => (
              <option key={item.panel} value={item.panel}>
                {item.label}{item.panel === "notifications" && unreadNotifications > 0 ? ` (${unreadNotifications})` : ""}
              </option>
            ))}
          </select>
        </label>

        {workspaceLoadStatus === "error" && (
          <div className="workspace-notice" role="alert">
            <div><strong>{copy.workspaceLoadErrorTitle}</strong><span>{copy.workspaceLoadErrorBody}</span></div>
            <button type="button" onClick={() => void loadWorkspace()}>{copy.tryAgain}</button>
          </div>
        )}

        {panel === "overview" && (
          <div className="control-content">
            {preview && (
              <section className="control-demo-banner">
                <div><span>{copy.previewMode}</span><strong>{copy.demoPanelTitle}</strong><p>{copy.demoPanelBody}</p></div>
                <a href={templateUrl} target="_blank" rel="noopener noreferrer">{copy.getTemplate} <b aria-hidden="true">↗</b></a>
              </section>
            )}

            <section className="control-heading">
              <span>{copy.dashboardEyebrow}</span>
              <h1>{copy.welcomeDashboard(displayName)}</h1>
              <p>{copy.dashboardSubtitle}</p>
            </section>

            <section className="control-stats" aria-label={copy.statusSummary}>
              <article><span>{copy.statusLabel}</span><strong><i className="status-dot" />{copy.assistantOnline}</strong><p>{copy.statusReadyBody}</p></article>
              <article><span>{copy.privacyLabel}</span><strong>{copy.privateToYou}</strong><p>{copy.privacyStatusBody}</p></article>
              <article><span>{copy.memoryLabel}</span><strong>{copy.contextOn}</strong><p>{copy.memoryStatusBody}</p></article>
            </section>

            <section className="control-grid">
              <article className="assistant-card">
                <div className="assistant-card-top">
                  <div className="assistant-orb" aria-hidden="true">✦</div>
                  <span>{copy.privateAssistant}</span>
                </div>
                <h2>{profile?.name ?? copy.assistantReadyTitle}</h2>
                <p>{profile?.description ?? copy.assistantReadyBody}</p>
                <button className="btn btn-primary" onClick={() => openPanel("assistant")}>{copy.openAssistant} <span aria-hidden="true">→</span></button>
              </article>

              <article className="quick-start-card">
                <span>{copy.quickStart}</span>
                <h2>{copy.quickStartTitle}</h2>
                <p>{copy.quickStartBody}</p>
                <div className="quick-prompts">
                  {startingPrompts.map((prompt) => (
                    <button key={prompt} onClick={() => openPrompt(prompt)}>{prompt}<span aria-hidden="true">→</span></button>
                  ))}
                </div>
              </article>
            </section>

            <section className="dashboard-section-heading">
              <div><span>{copy.workspaceToolsEyebrow}</span><h2>{copy.workspaceToolsTitle}</h2></div>
              <p>{copy.workspaceToolsBody}</p>
            </section>

            <section className="workspace-tools-grid">
              <button onClick={() => openPanel("prompts")}>
                <span aria-hidden="true">⌘</span>
                <div><strong>{copy.controlPrompts}</strong><p>{copy.promptsToolBody}</p></div>
                <b aria-hidden="true">→</b>
              </button>
              <button onClick={() => openPanel("history")}>
                <span aria-hidden="true">↻</span>
                <div><strong>{copy.controlHistory}</strong><p>{copy.historyToolBody}</p></div>
                <b aria-hidden="true">→</b>
              </button>
              <button onClick={() => openPanel("usage")}>
                <span aria-hidden="true">◫</span>
                <div><strong>{copy.controlUsage}</strong><p>{copy.usageToolBody}</p></div>
                <b aria-hidden="true">→</b>
              </button>
              <button onClick={() => openPanel("support")}>
                <span aria-hidden="true">?</span>
                <div><strong>{copy.controlSupport}</strong><p>{copy.supportToolBody}</p></div>
                <b aria-hidden="true">→</b>
              </button>
            </section>

            <section className="dashboard-activity-card">
              <header><div><span>{copy.activityEyebrow}</span><h2>{copy.recentActivityTitle}</h2></div><button onClick={() => openPanel("history")}>{copy.viewAll}</button></header>
              <div className="dashboard-activity-list">
                <div><i className="status-dot" /><span><strong>{copy.activityAssistantReady}</strong><small>{copy.activityAssistantReadyBody}</small></span><em>{copy.nowLabel}</em></div>
                <div><i>✓</i><span><strong>{copy.activityMemoryReady}</strong><small>{copy.activityMemoryReadyBody}</small></span><em>{copy.activeAccess}</em></div>
                <div><i>⌁</i><span><strong>{copy.activityPrivacyReady}</strong><small>{copy.activityPrivacyReadyBody}</small></span><em>{copy.activeAccess}</em></div>
              </div>
            </section>

            <section className="control-plan-strip">
              <div><span>{copy.planLabel}</span><strong>{planName}</strong></div>
              <div><span>{copy.accessLabel}</span><strong>{copy.activeAccess}</strong></div>
              <button onClick={() => openPanel("account")}>{copy.viewAccount} <span aria-hidden="true">→</span></button>
            </section>
          </div>
        )}

        {panel === "assistant" && studentMode && (
          <div className="control-content control-chat-content st-desk">
            <section className="control-heading control-heading-row">
              <div><h1>Your study desk</h1></div>
              <button type="button" className="btn btn-primary st-new-topic" onClick={() => void startNewTopic()} disabled={sending || newTopicStatus === "working"}>+ New question</button>
            </section>
            {confirmNewTopic && (
              <div className="st-confirm" role="alert">
                <span>{newTopicStatus === "error" ? "That didn't work. Please try again." : "Start a new question? This clears the conversation on screen."}</span>
                <div>
                  <button type="button" className="btn btn-primary" onClick={() => void startNewTopic()} disabled={newTopicStatus === "working"}>{newTopicStatus === "working" ? "Clearing…" : "Yes, start fresh"}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => { setConfirmNewTopic(false); setNewTopicStatus("idle"); }} disabled={newTopicStatus === "working"}>Cancel</button>
                </div>
              </div>
            )}
            <div className="chat-window">
              <p className="st-reminder"><i aria-hidden="true" />Explains and finds sources. It won&apos;t write your coursework for you.</p>
              <div className="chat-messages" ref={chatMessagesRef}>
                {messages.length === 0 && (
                  <div className="st-empty">
                    <strong>What are you working on?</strong>
                    <p>Ask about a topic, or pick a starting point below. Answers come with links to their sources.</p>
                  </div>
                )}
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={message.role === "user" ? "msg msg-user" : message.error || !message.content ? "msg msg-assistant" : "msg msg-assistant msg-md"}
                    data-label={message.role === "user" ? "You" : "Tutor"}
                    style={message.error ? { color: "#b91c1c" } : undefined}
                  >
                    {message.role !== "user" && !message.error && message.content
                      ? <ChatMarkdown text={message.content} />
                      : message.content || (sending && index === messages.length - 1 ? <WorkingIndicator label="Researching" /> : "")}
                    {canRetry(index) && <button type="button" className="chat-retry" onClick={retryLastQuestion}>Try again</button>}
                  </div>
                ))}
                {sending && slowTurn && !messages[messages.length - 1]?.content && (
                  <p className="chat-working-note" role="status">
                    {turnsOutliveThePage
                      ? "Still researching. Bigger questions can take a few minutes, and you can leave this page: the answer will be here when you come back."
                      : "Still researching. Bigger questions can take a few minutes."}
                  </p>
                )}
              </div>
              <div className="st-chips" aria-label="Starting points">
                {([
                  ["Explain a topic", "Explain this topic to me step by step: "],
                  ["Find sources", "Find reliable sources I can cite about: "],
                  ["Plan my essay", "Help me plan (not write) an essay on: "],
                  ["Check my paragraph", "Give me feedback on this paragraph I wrote: "],
                ] as const).map(([label, prefix]) => (
                  <button key={label} type="button" onClick={() => startWith(prefix)} disabled={sending || newTopicStatus === "working"}>{label}</button>
                ))}
              </div>
              <form className="chat-input-row" onSubmit={handleSend}>
                <label className="sr-only" htmlFor="assistant-message">Your question</label>
                <textarea id="assistant-message" ref={assistantInputRef} rows={1} placeholder="Ask a question…" value={input} onChange={(event) => { setInput(event.target.value); fitComposer(event.currentTarget); }} onKeyDown={sendOnEnter} disabled={sending || newTopicStatus === "working"} />
                <button type="submit" className="btn btn-primary" disabled={sending || newTopicStatus === "working" || !input.trim()}>{copy.send}</button>
              </form>
            </div>
          </div>
        )}

        {panel === "assistant" && !studentMode && (
          <div className="control-content control-chat-content">

            <div className="chat-window">
              <div className="chat-messages" ref={chatMessagesRef}>
                {messages.length === 0 && <div className="dashboard-chat-empty">
                  <span className="dashboard-assistant-mark"><DashboardIcon name="assistant" /></span>
                  <p className="chat-empty">{profile?.greeting ?? copy.chatGreeting}</p>
                  {profile && <div className="preset-starters" aria-label={copy.quickStart}>
                    {profile.workflows.map((job) => <button key={job.kicker} type="button" onClick={() => openPrompt(job.prompt)}>{job.title}<DashboardIcon name="arrow" /></button>)}
                  </div>}
                  {!simpleMode && <button type="button" className="dashboard-prompt-link" onClick={() => openPanel("prompts")}>{copy.controlPrompts}<DashboardIcon name="arrow" /></button>}
                </div>}
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={message.role === "user" ? "msg msg-user" : message.error || !message.content ? "msg msg-assistant" : "msg msg-assistant msg-md"}
                    data-label={message.role === "user" ? copy.you : copy.assistant}
                    style={message.error ? { color: "#b91c1c" } : undefined}
                  >
                    {/* Replies are Markdown; the customer's own text stays as typed. */}
                    {message.role !== "user" && !message.error && message.content
                      ? <ChatMarkdown text={message.content} />
                      : message.content || (sending && index === messages.length - 1 ? <WorkingIndicator /> : "")}
                    {canRetry(index) && <button type="button" className="chat-retry" onClick={retryLastQuestion}>{copy.tryAgain}</button>}
                  </div>
                ))}
                {sending && slowTurn && !messages[messages.length - 1]?.content && (
                  <p className="chat-working-note" role="status">
                    {turnsOutliveThePage ? copy.chatStillWorkingLeave : copy.chatStillWorking}
                  </p>
                )}
              </div>
              <form className="chat-input-row" onSubmit={handleSend}>
                <label className="sr-only" htmlFor="assistant-message">{copy.messageLabel}</label>
                <textarea id="assistant-message" ref={assistantInputRef} rows={1} placeholder={copy.messagePlaceholder} value={input} onChange={(event) => { setInput(event.target.value); fitComposer(event.currentTarget); }} onKeyDown={sendOnEnter} disabled={sending} />
                <button type="submit" className="btn btn-primary dashboard-send" aria-label={copy.send} title={copy.send} disabled={sending || !input.trim()}><DashboardIcon name="send" /></button>
              </form>
            </div>
          </div>
        )}

        {panel === "prompts" && (
          <div className="control-content">
            <section className="control-heading">
              <span>{copy.promptsEyebrow}</span>
              <h1>{copy.promptsTitle}</h1>
              <p>{profile?.description ?? copy.promptsSubtitle}</p>
            </section>
            <section className="prompt-library-grid">
              {promptLibrary.map(([prompt, body, category]) => (
                <button key={prompt} onClick={() => openPrompt(prompt)}>
                  <span>{category}</span>
                  <strong>{prompt}</strong>
                  <p>{body}</p>
                  <b>{copy.usePrompt} <i aria-hidden="true">→</i></b>
                </button>
              ))}
            </section>
          </div>
        )}

        {panel === "history" && (
          <div className="control-content">
            <section className="control-heading">
              <span>{copy.historyEyebrow}</span>
              <h1>{copy.historyTitle}</h1>
              <p>{copy.historySubtitle}</p>
            </section>
            <section className="activity-summary-grid">
              <article><span>{copy.savedConversations}</span><strong>{copy.turnCount(savedTurns)}</strong><p>{copy.savedHistoryBody}</p></article>
              <article><span>{copy.currentSession}</span><strong>{copy.turnCount(userTurns)}</strong><p>{copy.sessionTurnsBody}</p></article>
              <article><span>{copy.workspaceStatus}</span><strong><i className="status-dot" />{copy.assistantOnline}</strong><p>{copy.statusReadyBody}</p></article>
            </section>
            <section className="session-activity-panel">
              <header><div><span>{copy.savedHistory}</span><h2>{copy.historyListTitle}</h2></div><button onClick={() => openPanel("assistant")}>{copy.continueConversation}</button></header>
              {workspaceLoadStatus === "loading" ? (
                <div className="panel-loading" role="status"><span className="spinner" aria-hidden="true" /><strong>{copy.loadingHistory}</strong><p>{copy.loadingHistoryBody}</p></div>
              ) : workspaceLoadStatus === "error" ? (
                <div className="activity-empty"><span aria-hidden="true">!</span><strong>{copy.historyUnavailableTitle}</strong><p>{copy.historyUnavailableBody}</p><button className="btn btn-primary" type="button" onClick={() => void loadWorkspace()}>{copy.tryAgain}</button></div>
              ) : messages.length === 0 ? (
                <div className="activity-empty"><span aria-hidden="true">↻</span><strong>{copy.noHistoryTitle}</strong><p>{copy.noHistoryBody}</p><button className="btn btn-primary" onClick={() => openPanel(simpleMode ? "assistant" : "prompts")}>{simpleMode ? copy.continueConversation : copy.browsePrompts}</button></div>
              ) : (
                <div className="session-message-list">
                  {messages.filter((message) => message.content).map((message, index) => (
                    <div key={message.id ?? `${message.role}-${index}`}>
                      <span>{message.role === "user" ? copy.you : copy.assistant}</span>
                      <p>{message.content}</p>{message.createdAt && <time>{new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(message.createdAt))}</time>}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {panel === "usage" && (
          <div className="control-content">
            <section className="control-heading">
              <span>{copy.usageEyebrow}</span>
              <h1>{copy.usageTitle}</h1>
              <p>{copy.usageSubtitle}</p>
            </section>
            <section className="usage-grid">
              <article className="usage-metric-card"><span>{copy.savedMessages}</span><strong>{savedTurns}</strong><p>{copy.savedMessagesBody}</p></article>
              <article className="usage-metric-card"><span>{copy.savedReplies}</span><strong>{savedReplies}</strong><p>{copy.savedRepliesBody}</p></article>
              <article className="usage-metric-card"><span>{copy.latestActivity}</span><strong className="usage-date">{latestActivityAt ? formatDateTime(latestActivityAt, locale) : copy.noActivityYet}</strong><p>{copy.latestActivityBody}</p></article>
            </section>
            <section className="usage-detail-grid">
              <article className="usage-plan-card">
                <span>{copy.planLabel}</span><h2>{planName}</h2><p>{copy.usagePlanBody}</p>
                <div><span>{copy.assistantAccessLabel}</span><strong><i className="status-dot" />{copy.activeAccess}</strong></div>
                <div><span>{copy.privacyLabel}</span><strong>{copy.privateToYou}</strong></div>
                <button className="btn btn-secondary" onClick={() => openPanel("account")}>{copy.viewAccount}</button>
              </article>
              <article className="usage-session-card">
                <span>{copy.sessionBreakdown}</span><h2>{copy.sessionBreakdownTitle}</h2><p>{copy.sessionBreakdownBody}</p>
                <div className="usage-bars">
                  <div><span>{copy.yourMessages}: {userTurns}</span><b style={{ width: `${Math.min(100, Math.max(userTurns > 0 ? 8 : 0, userTurns * 18))}%` }} /></div>
                  <div><span>{copy.assistantRepliesLabel}: {assistantReplies}</span><b style={{ width: `${Math.min(100, Math.max(assistantReplies > 0 ? 8 : 0, assistantReplies * 18))}%` }} /></div>
                </div>
                <small>{copy.usageNoQuotaNote}</small>
              </article>
            </section>
          </div>
        )}

        {panel === "notifications" && (
          <div className="control-content">
            <section className="control-heading control-heading-row">
              <div><span>{copy.notificationsEyebrow}</span><h1>{copy.notificationsTitle}</h1><p>{copy.notificationsSubtitle}</p></div>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={unreadNotifications === 0}
                onClick={() => markNotificationsRead(notificationItems.map((item) => item.id))}
              >
                {unreadNotifications === 0 ? copy.allRead : copy.markAllRead}
              </button>
            </section>
            <section className="notification-panel" aria-label={copy.notificationsTitle}>
              <header><span>{copy.workspaceUpdates}</span><strong aria-live="polite">{copy.unreadCount(unreadNotifications)}</strong></header>
              <div className="notification-list">
                {notificationItems.map((item) => {
                  const unread = !readNotificationIds.includes(item.id);
                  return (
                    <article key={item.id} className={unread ? "is-unread" : ""}>
                      <i aria-hidden="true">{item.icon}</i>
                      <div><strong>{item.title}</strong><p>{item.body}</p></div>
                      <span>{unread ? copy.newNotification : copy.readNotification}</span>
                    </article>
                  );
                })}
              </div>
              <p className="notification-note">{copy.notificationsScopeNote}</p>
            </section>
          </div>
        )}

        {panel === "billing" && (
          <div className="control-content">
            <section className="control-heading"><span>{copy.billingEyebrow}</span><h1>{copy.billingTitle}</h1><p>{copy.billingSubtitle}</p></section>
            <section className="billing-grid">
              <article className="billing-plan-card">
                <span>{copy.currentPlan}</span><h2>{planName}</h2><p>{billingMode === "subscription" ? copy.subscriptionBillingBody : billingMode === "payment" ? copy.oneTimeBillingBody : copy.includedBillingBody}</p>
                <div><span>{copy.billingStatusLabel}</span><strong><i className="status-dot" />{billingStateLabel}</strong></div>
                {billingMode === "subscription" && !preview && <button className="btn btn-primary" onClick={openBillingPortal} disabled={billingStatus === "opening"}>{billingStatus === "opening" ? copy.openingBilling : copy.manageBilling}</button>}
                {preview && <a className="btn btn-primary" href={templateUrl} target="_blank" rel="noopener noreferrer">{copy.getTemplate}</a>}
                {billingStatus === "error" && <p className="panel-error" role="alert">{copy.billingError}</p>}
              </article>
              <article className="billing-info-card"><span>{copy.billingHelp}</span><h2>{copy.billingHelpTitle}</h2><p>{copy.billingHelpBody}</p>{supportEmail ? <a href={supportHref}>{copy.emailSupport} <b aria-hidden="true">→</b></a> : <p>{copy.contactOwner}</p>}</article>
            </section>
          </div>
        )}

        {panel === "channels" && channelsEnabled && (
          <ChannelsPanel copy={copy} preview={preview} />
        )}

        {panel === "modelKey" && byokEnabled && (
          <ModelKeyPanel copy={copy} brandName={brandName} preview={preview} />
        )}

        {panel === "botTools" && botTools.length > 0 && (
          <BotToolsPanel copy={copy} preview={preview} tools={botTools} />
        )}

        {panel === "settings" && (
          <div className="control-content">
            <section className="control-heading"><span>{copy.settingsEyebrow}</span><h1>{copy.settingsTitle}</h1><p>{copy.settingsSubtitle}</p></section>
            <form className="settings-panel" onSubmit={savePreferences}>
              {workspaceLoadStatus === "loading" && <div className="settings-state" role="status"><span className="mini-spinner" aria-hidden="true" />{copy.loadingPreferences}</div>}
              {workspaceLoadStatus === "error" && <div className="settings-state panel-error" role="alert"><span>{copy.preferencesUnavailable}</span><button type="button" onClick={() => void loadWorkspace()}>{copy.tryAgain}</button></div>}
              <fieldset disabled={workspaceLoadStatus !== "ready" || preferencesStatus === "saving"}><legend>{copy.responseStyle}</legend><p>{copy.responseStyleBody}</p><div className="style-options">
                {(["concise", "balanced", "detailed"] as const).map((style) => <label key={style} className={preferencesDraft.responseStyle === style ? "selected" : ""}><input type="radio" name="responseStyle" value={style} checked={preferencesDraft.responseStyle === style} onChange={() => { setPreferencesDraft((current) => ({ ...current, responseStyle: style })); setPreferencesStatus("idle"); }} /><strong>{style === "concise" ? copy.styleConcise : style === "balanced" ? copy.styleBalanced : copy.styleDetailed}</strong><span>{style === "concise" ? copy.styleConciseBody : style === "balanced" ? copy.styleBalancedBody : copy.styleDetailedBody}</span></label>)}
              </div></fieldset>
              <fieldset className="instructions-field" disabled={workspaceLoadStatus !== "ready" || preferencesStatus === "saving"}><legend>{copy.customInstructions}</legend><span>{copy.customInstructionsBody}</span><textarea value={preferencesDraft.customInstructions} maxLength={MAX_CUSTOM_INSTRUCTIONS_CHARS} rows={5} placeholder={copy.customInstructionsPlaceholder} onChange={(event) => { setPreferencesDraft((current) => ({ ...current, customInstructions: event.target.value })); setPreferencesStatus("idle"); }} /><small>{preferencesDraft.customInstructions.length}/{MAX_CUSTOM_INSTRUCTIONS_CHARS}</small></fieldset>
              <div className="settings-actions"><button type="submit" className="btn btn-primary" disabled={workspaceLoadStatus !== "ready" || preferencesStatus === "saving"}>{preferencesStatus === "saving" ? copy.saving : copy.saveSettings}</button><button type="button" className="settings-reset" disabled={workspaceLoadStatus !== "ready" || preferencesStatus === "saving"} onClick={() => { setPreferencesDraft(preferences); setPreferencesStatus("idle"); }}>{copy.discardChanges}</button>{preferencesStatus === "saved" && <span role="status">✓ {copy.settingsSaved}</span>}{preferencesStatus === "error" && <span className="panel-error" role="alert">{copy.settingsError}</span>}</div>
            </form>
          </div>
        )}

        {panel === "security" && (
          <div className="control-content">
            <section className="control-heading"><span>{copy.securityEyebrow}</span><h1>{copy.securityTitle}</h1><p>{copy.securitySubtitle}</p></section>
            <section className="security-grid">
              <article className="session-card">
                <span>{copy.currentBrowserSession}</span><h2>{copy.sessionActiveTitle}</h2><p>{copy.sessionActiveBody}</p>
                <dl>
                  <div><dt>{copy.signedInAt}</dt><dd>{formatDateTime(sessionStartedAt, locale)}</dd></div>
                  <div><dt>{copy.sessionExpires}</dt><dd>{formatDateTime(sessionExpiresAt, locale)}</dd></div>
                </dl>
                {!preview && <button className="btn btn-secondary" type="button" onClick={handleLogout} disabled={logoutStatus === "working"}>{logoutStatus === "working" ? copy.loggingOut : copy.signOutThisDevice}</button>}
                {logoutStatus === "error" && <p className="panel-error" role="alert">{copy.logoutError}</p>}
              </article>
              <article className="session-card">
                <span>{copy.otherSessions}</span><h2>{copy.secureAccountTitle}</h2><p>{copy.secureAccountBody}</p>
                <button className="btn btn-primary" type="button" onClick={revokeOtherSessions} disabled={sessionStatus === "working"}>{sessionStatus === "working" ? copy.revokingSessions : copy.signOutOtherSessions}</button>
                {sessionStatus === "done" && <p className="panel-success" role="status">✓ {preview ? copy.previewSessionComplete : copy.sessionsRevoked}</p>}
                {sessionStatus === "error" && <p className="panel-error" role="alert">{copy.sessionsRevokeError}</p>}
              </article>
            </section>
            <p className="security-note">{copy.securityScopeNote}</p>
          </div>
        )}

        {panel === "account" && (
          <div className="control-content">
            <section className="control-heading"><span>{copy.accountEyebrow}</span><h1>{copy.accountTitle}</h1><p>{copy.accountSubtitle}</p></section>
            <section className="account-panel">
              <div><span>{copy.emailLabel}</span><strong>{email}</strong></div>
              <div><span>{copy.planLabel}</span><strong>{planName}</strong></div>
              <div><span>{copy.assistantAccessLabel}</span><strong><i className="status-dot" />{copy.activeAccess}</strong></div>
              {accountCreatedAt && <div><span>{copy.accountCreated}</span><strong>{formatDate(accountCreatedAt, locale)}</strong></div>}
              {preview ? (
                <a className="btn btn-primary" href={templateUrl} target="_blank" rel="noopener noreferrer">{copy.getTemplate}</a>
              ) : (
                <button className="btn btn-secondary" onClick={handleLogout} disabled={logoutStatus === "working"}>{logoutStatus === "working" ? copy.loggingOut : copy.logout}</button>
              )}
              {logoutStatus === "error" && <p className="panel-error account-action-message" role="alert">{copy.logoutError}</p>}
            </section>
            <section className="account-info-grid">
              <article><span>{copy.workspacePreferences}</span><h2>{copy.languageAndRegion}</h2><p>{locale === "zh" ? copy.simplifiedChinese : copy.englishLanguage}</p><LanguageSwitcher locale={locale} locked={localeLocked} previewPreset={preview && !studentMode ? customerPresetId : undefined} /></article>
              <article><span>{copy.privacyLabel}</span><h2>{copy.privateWorkspaceTitle}</h2><p>{copy.privateWorkspaceBody}</p><button onClick={() => openPanel("support")}>{copy.learnMore}</button></article>
            </section>
          </div>
        )}

        {panel === "privacy" && (
          <div className="control-content">
            <section className="control-heading"><span>{copy.privacyDataEyebrow}</span><h1>{copy.privacyDataTitle}</h1><p>{copy.privacyDataSubtitle}</p></section>
            <section className="privacy-grid">
              <article><span aria-hidden="true">⇩</span><div><h2>{copy.downloadDataTitle}</h2><p>{copy.downloadDataBody}</p><button className="btn btn-secondary" onClick={downloadData} disabled={downloadStatus === "working"}>{downloadStatus === "working" ? copy.preparingData : copy.downloadData}</button>{downloadStatus === "done" && <p className="panel-success" role="status">✓ {copy.downloadComplete}</p>}{downloadStatus === "error" && <p className="panel-error" role="alert">{copy.downloadError}</p>}</div></article>
              <article><span aria-hidden="true">↻</span><div><h2>{copy.clearHistoryTitle}</h2><p>{copy.clearHistoryBody}</p><button className={`btn ${confirmClear ? "btn-danger" : "btn-secondary"}`} onClick={clearHistory} disabled={clearStatus === "working" || sending}>{clearStatus === "working" ? copy.clearingHistory : confirmClear ? copy.confirmClearHistory : copy.clearHistory}</button>{confirmClear && clearStatus !== "working" && <button className="privacy-cancel" onClick={() => setConfirmClear(false)}>{copy.cancel}</button>}{clearStatus === "done" && <p className="panel-success" role="status">✓ {copy.historyCleared}</p>}{clearStatus === "error" && <p className="panel-error" role="alert">{copy.clearHistoryError}</p>}</div></article>
              <article className="danger-zone-card"><span aria-hidden="true">!</span><div><h2>{copy.deleteAccountTitle}</h2><p>{copy.deleteAccountBody}</p>{!confirmDelete ? <button className="btn btn-secondary" type="button" onClick={deleteAccount}>{copy.deleteAccount}</button> : <div className="delete-confirmation"><label htmlFor="delete-confirmation"><strong>{copy.deleteConfirmLabel(email)}</strong><input id="delete-confirmation" type="email" autoComplete="off" value={deleteConfirmation} onChange={(event) => { setDeleteConfirmation(event.target.value); setDeleteStatus("idle"); }} placeholder={email} /></label><div><button className="btn btn-danger" type="button" onClick={deleteAccount} disabled={deleteStatus === "working" || deleteConfirmation.trim().toLowerCase() !== email.toLowerCase()}>{deleteStatus === "working" ? copy.deletingAccount : copy.confirmDeleteAccount}</button><button className="privacy-cancel" type="button" disabled={deleteStatus === "working"} onClick={() => { setConfirmDelete(false); setDeleteConfirmation(""); setDeleteStatus("idle"); }}>{copy.cancel}</button></div></div>}{deleteStatus === "done" && <p className="panel-success" role="status">✓ {copy.previewDeleteComplete}</p>}{deleteStatus === "error" && <p className="panel-error" role="alert">{copy.deleteAccountError}</p>}</div></article>
            </section>
            <p className="privacy-note">{copy.dataScopeNote}</p>
          </div>
        )}

        {panel === "support" && (
          <div className="control-content">
            <section className="control-heading">
              <span>{copy.supportEyebrow}</span>
              <h1>{copy.supportTitle}</h1>
              <p>{copy.supportSubtitle}</p>
            </section>
            <section className="support-grid">
              <article className="support-contact-card">
                <span>{copy.contactSupport}</span><h2>{copy.needHelpTitle}</h2><p>{copy.needHelpBody}</p>
                {supportEmail ? <a className="btn btn-primary" href={supportHref}>{copy.emailSupport}</a> : <p className="support-unavailable">{copy.supportUnavailableTitle}<small>{copy.contactOwner}</small></p>}
              </article>
              <article className="support-links-card">
                <span>{copy.resources}</span><h2>{copy.accountResources}</h2>
                {!simpleMode && <button onClick={() => openPanel("prompts")}><strong>{copy.controlPrompts}</strong><small>{copy.promptsToolBody}</small><b aria-hidden="true">→</b></button>}
                {!simpleMode && <button onClick={() => openPanel("usage")}><strong>{copy.controlUsage}</strong><small>{copy.usageToolBody}</small><b aria-hidden="true">→</b></button>}
                {privacyUrl && <a href={privacyUrl} target="_blank" rel="noopener noreferrer"><strong>{copy.privacyPolicy}</strong><small>{copy.privacyPolicyBody}</small><b aria-hidden="true">↗</b></a>}
                {termsUrl && <a href={termsUrl} target="_blank" rel="noopener noreferrer"><strong>{copy.termsOfService}</strong><small>{copy.termsOfServiceBody}</small><b aria-hidden="true">↗</b></a>}
              </article>
            </section>
            <section className="faq-panel">
              <header><span>{copy.commonQuestions}</span><h2>{copy.faqPanelTitle}</h2></header>
              <details><summary>{copy.controlFaqOneQuestion}</summary><p>{copy.controlFaqOneAnswer}</p></details>
              <details><summary>{copy.controlFaqTwoQuestion}</summary><p>{copy.controlFaqTwoAnswer}</p></details>
              <details><summary>{copy.controlFaqThreeQuestion}</summary><p>{copy.controlFaqThreeAnswer}</p></details>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

/** Grow the composer with its text, up to the CSS max-height, then scroll. */
function fitComposer(field: HTMLTextAreaElement | null) {
  if (!field) return;
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
}

/** Enter sends and Shift+Enter adds a line. Never while an input method is
 *  composing (Chinese, Japanese, Korean): that Enter picks a candidate. Safari
 *  reports it only through keyCode 229. */
function sendOnEnter(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey) return;
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function localizedChatError(
  status: number,
  locale: Locale,
  copy: (typeof translations)[Locale]
): string {
  if (status === 402) return copy.activateTitle;
  if (status === 429) {
    return locale === "zh" ? "消息发送过快，请稍后再试。" : "You’re sending messages too fast. Please slow down.";
  }
  if (status === 413) return locale === "zh" ? "消息内容过长。" : "Your message is too long.";
  if (status === 409) {
    return locale === "zh" ? "你的助手还在处理上一个请求，请等它完成。" : "Your assistant is still working on your last request.";
  }
  return copy.chatError;
}

function formatDateTime(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDate(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
  }).format(new Date(value));
}

function appendToLastAssistantMessage(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  delta: string,
  interrupted = false
) {
  setMessages((prev) => {
    const next = [...prev];
    const lastIndex = next.length - 1;
    if (lastIndex >= 0 && next[lastIndex].role === "assistant") {
      next[lastIndex] = { ...next[lastIndex], content: next[lastIndex].content + delta, ...(interrupted ? { interrupted: true } : {}) };
    }
    return next;
  });
}

/** Replace (not append to) the last assistant bubble — used for error states so
 *  the empty placeholder becomes a readable message instead of hanging on "…". */
function setLastAssistantMessage(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  content: string,
  error = false
) {
  setMessages((prev) => {
    const next = [...prev];
    const lastIndex = next.length - 1;
    if (lastIndex >= 0 && next[lastIndex].role === "assistant") {
      next[lastIndex] = { ...next[lastIndex], content, error };
    }
    return next;
  });
}

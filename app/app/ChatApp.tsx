"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { messages as translations, type Locale } from "../../lib/i18n";
import LanguageSwitcher from "../LanguageSwitcher";
import {
  defaultAssistantPreferences,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  type AssistantPreferences,
  type StoredChatMessage,
} from "../../lib/customerWorkspace";

interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  error?: boolean;
}

// White-label: the end-user must never see the reseller's raw upstream error text
// (e.g. an account billing/plan message), so any turn failure collapses to this.
// A chat error whose `message` is SAFE to display verbatim (our own friendly copy).
// Anything thrown that is NOT this (raw fetch/stream exceptions) is shown as the
// generic line instead, so implementation details never reach the end-user.
class ChatDisplayError extends Error {}

type ProvisionState = "checking" | "provisioning" | "ready" | "error";
type Panel = "overview" | "assistant" | "prompts" | "history" | "usage" | "notifications" | "billing" | "settings" | "security" | "account" | "privacy" | "support";
type AsyncStatus = "idle" | "working" | "done" | "error";
type WorkspaceLoadStatus = "loading" | "ready" | "error";

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~2 minutes, covers the 30-90s cold-start window

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
  preview = false,
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
  preview?: boolean;
}) {
  const copy = translations[locale];
  const router = useRouter();
  const needsPayment = paymentsEnabled && !paid;
  const [provisionState, setProvisionState] = useState<ProvisionState>(preview ? "ready" : "checking");
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("overview");
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const hasLocalActivityRef = useRef(false);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const mainContentRef = useRef<HTMLElement>(null);
  const panelInitializedRef = useRef(false);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

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
        if (!hasLocalActivityRef.current) setMessages(storedMessages);
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
    let attempts = 0;

    const poll = async (): Promise<void> => {
      attempts += 1;
      try {
        const res = await fetch("/api/provision", { method: "POST" });
        const data = await res.json();

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
        setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        setProvisionError(copy.serverUnavailable);
        setProvisionState("error");
      }
    };

    await poll();
  }, [copy.provisionFailed, copy.provisionSlow, copy.serverUnavailable, copy.storefrontUnavailable]);

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
  }, [messages]);

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

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending) return;

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

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });

      if (!res.ok || !res.body) {
        // Our own API errors carry a friendly `message` (402 pay, 429 slow down,
        // 413 too long) — show ONLY that (never `data.error`, which can be a raw
        // code/text). Anything else collapses to the generic line.
        const known = res.status === 402 || res.status === 429 || res.status === 413;
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
        appendToLastAssistantMessage(setMessages, `\n\n${copy.interrupted}`);
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
      // If a partial reply already streamed, keep it and add the interrupted note;
      // otherwise replace the empty placeholder bubble with the error message.
      if (gotContent) {
        appendToLastAssistantMessage(setMessages, `\n\n${copy.interrupted}`);
      } else {
        setLastAssistantMessage(setMessages, msg, true);
      }
    } finally {
      setSending(false);
    }
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
    setPanel("assistant");
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
        <LanguageSwitcher locale={locale} locked={localeLocked} />
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

  if (provisionState === "checking" || provisionState === "provisioning") {
    return (
      <div className="provisioning">
        <div className="spinner" />
        <LanguageSwitcher locale={locale} locked={localeLocked} />
        <h2>{copy.provisioningTitle}</h2>
        <p>{copy.provisioningBody(email.split("@")[0])}</p>
      </div>
    );
  }

  if (provisionState === "error") {
    return (
      <div className="provisioning">
        <LanguageSwitcher locale={locale} locked={localeLocked} />
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
  const primaryNav: { panel: Panel; label: string; icon: string }[] = [
    { panel: "overview", label: copy.controlOverview, icon: "⌂" },
    { panel: "assistant", label: copy.controlAssistant, icon: "✦" },
    { panel: "prompts", label: copy.controlPrompts, icon: "⌘" },
    { panel: "history", label: copy.controlHistory, icon: "↻" },
    { panel: "usage", label: copy.controlUsage, icon: "◫" },
    { panel: "notifications", label: copy.controlNotifications, icon: "◉" },
  ];
  const manageNav: { panel: Panel; label: string; icon: string }[] = [
    { panel: "billing", label: copy.controlBilling, icon: "$" },
    { panel: "settings", label: copy.controlSettings, icon: "⚙" },
    { panel: "security", label: copy.controlSecurity, icon: "◇" },
    { panel: "account", label: copy.controlAccount, icon: "○" },
    { panel: "privacy", label: copy.controlPrivacy, icon: "⌁" },
    { panel: "support", label: copy.controlSupport, icon: "?" },
  ];
  const allNav = [...primaryNav, ...manageNav];
  const currentPanelTitle = allNav.find(
    (item) => item.panel === panel
  )?.label;
  const supportHref = supportEmail
    ? `mailto:${supportEmail}?subject=${encodeURIComponent(copy.supportEmailSubject)}&body=${encodeURIComponent(copy.supportEmailBody(email))}`
    : "";

  return (
    <div className="control-shell">
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
              onClick={() => setPanel(item.panel)}
            >
              <span aria-hidden="true">{item.icon}</span>{item.label}
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
              onClick={() => setPanel(item.panel)}
            >
              <span aria-hidden="true">{item.icon}</span>{item.label}
            </button>
          ))}
        </nav>

        <div className="control-sidebar-account">
          <span>{copy.signedInAs}</span>
          <strong>{displayName}</strong>
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
            <span>{copy.workspace}</span>
            <strong>{currentPanelTitle}</strong>
          </div>
          <div className="control-topbar-actions">
            <span className={`control-live ${workspaceLoadStatus === "error" ? "is-error" : ""}`} role="status">
              {workspaceLoadStatus === "loading" ? <span className="mini-spinner" aria-hidden="true" /> : <i />}
              {workspaceLoadStatus === "loading" ? copy.syncingWorkspace : workspaceLoadStatus === "error" ? copy.syncFailed : copy.onlineNow}
            </span>
            <LanguageSwitcher locale={locale} locked={localeLocked} />
          </div>
        </header>

        <label className="control-mobile-nav">
          <span>{copy.mobileNavigationLabel}</span>
          <select id="control-mobile-section" name="control-section" value={panel} onChange={(event) => setPanel(event.target.value as Panel)}>
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
                <h2>{copy.assistantReadyTitle}</h2>
                <p>{copy.assistantReadyBody}</p>
                <button className="btn btn-primary" onClick={() => setPanel("assistant")}>{copy.openAssistant} <span aria-hidden="true">→</span></button>
              </article>

              <article className="quick-start-card">
                <span>{copy.quickStart}</span>
                <h2>{copy.quickStartTitle}</h2>
                <p>{copy.quickStartBody}</p>
                <div className="quick-prompts">
                  {[copy.promptOne, copy.promptTwo, copy.promptThree].map((prompt) => (
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
              <button onClick={() => setPanel("prompts")}>
                <span aria-hidden="true">⌘</span>
                <div><strong>{copy.controlPrompts}</strong><p>{copy.promptsToolBody}</p></div>
                <b aria-hidden="true">→</b>
              </button>
              <button onClick={() => setPanel("history")}>
                <span aria-hidden="true">↻</span>
                <div><strong>{copy.controlHistory}</strong><p>{copy.historyToolBody}</p></div>
                <b aria-hidden="true">→</b>
              </button>
              <button onClick={() => setPanel("usage")}>
                <span aria-hidden="true">◫</span>
                <div><strong>{copy.controlUsage}</strong><p>{copy.usageToolBody}</p></div>
                <b aria-hidden="true">→</b>
              </button>
              <button onClick={() => setPanel("support")}>
                <span aria-hidden="true">?</span>
                <div><strong>{copy.controlSupport}</strong><p>{copy.supportToolBody}</p></div>
                <b aria-hidden="true">→</b>
              </button>
            </section>

            <section className="dashboard-activity-card">
              <header><div><span>{copy.activityEyebrow}</span><h2>{copy.recentActivityTitle}</h2></div><button onClick={() => setPanel("history")}>{copy.viewAll}</button></header>
              <div className="dashboard-activity-list">
                <div><i className="status-dot" /><span><strong>{copy.activityAssistantReady}</strong><small>{copy.activityAssistantReadyBody}</small></span><em>{copy.nowLabel}</em></div>
                <div><i>✓</i><span><strong>{copy.activityMemoryReady}</strong><small>{copy.activityMemoryReadyBody}</small></span><em>{copy.activeAccess}</em></div>
                <div><i>⌁</i><span><strong>{copy.activityPrivacyReady}</strong><small>{copy.activityPrivacyReadyBody}</small></span><em>{copy.activeAccess}</em></div>
              </div>
            </section>

            <section className="control-plan-strip">
              <div><span>{copy.planLabel}</span><strong>{planName}</strong></div>
              <div><span>{copy.accessLabel}</span><strong>{copy.activeAccess}</strong></div>
              <button onClick={() => setPanel("account")}>{copy.viewAccount} <span aria-hidden="true">→</span></button>
            </section>
          </div>
        )}

        {panel === "assistant" && (
          <div className="control-content control-chat-content">
            <section className="control-heading control-heading-row">
              <div><span>{copy.privateAssistant}</span><h1>{copy.chatTitle}</h1><p>{copy.chatSubtitle}</p></div>
              <button className="btn btn-secondary" onClick={() => setPanel("overview")}>{copy.backToOverview}</button>
            </section>
            <div className="chat-window">
              <div className="chat-messages" ref={chatMessagesRef}>
                {messages.length === 0 && <p className="chat-empty">{copy.chatGreeting}</p>}
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={message.role === "user" ? "msg msg-user" : "msg msg-assistant"}
                    data-label={message.role === "user" ? copy.you : copy.assistant}
                    style={message.error ? { color: "#b91c1c" } : undefined}
                  >
                    {message.content || (sending && index === messages.length - 1 ? "…" : "")}
                  </div>
                ))}
              </div>
              <form className="chat-input-row" onSubmit={handleSend}>
                <label className="sr-only" htmlFor="assistant-message">{copy.messageLabel}</label>
                <input id="assistant-message" type="text" placeholder={copy.messagePlaceholder} value={input} onChange={(event) => setInput(event.target.value)} disabled={sending} />
                <button type="submit" className="btn btn-primary" disabled={sending || !input.trim()}>{copy.send}</button>
              </form>
            </div>
          </div>
        )}

        {panel === "prompts" && (
          <div className="control-content">
            <section className="control-heading">
              <span>{copy.promptsEyebrow}</span>
              <h1>{copy.promptsTitle}</h1>
              <p>{copy.promptsSubtitle}</p>
            </section>
            <section className="prompt-library-grid">
              {[
                [copy.promptOne, copy.promptOneBody, copy.promptCategoryPlan],
                [copy.promptTwo, copy.promptTwoBody, copy.promptCategoryWrite],
                [copy.promptThree, copy.promptThreeBody, copy.promptCategoryThink],
                [copy.promptFour, copy.promptFourBody, copy.promptCategorySummarize],
                [copy.promptFive, copy.promptFiveBody, copy.promptCategoryCreate],
                [copy.promptSix, copy.promptSixBody, copy.promptCategoryDecide],
              ].map(([prompt, body, category]) => (
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
              <header><div><span>{copy.savedHistory}</span><h2>{copy.historyListTitle}</h2></div><button onClick={() => setPanel("assistant")}>{copy.continueConversation}</button></header>
              {workspaceLoadStatus === "loading" ? (
                <div className="panel-loading" role="status"><span className="spinner" aria-hidden="true" /><strong>{copy.loadingHistory}</strong><p>{copy.loadingHistoryBody}</p></div>
              ) : workspaceLoadStatus === "error" ? (
                <div className="activity-empty"><span aria-hidden="true">!</span><strong>{copy.historyUnavailableTitle}</strong><p>{copy.historyUnavailableBody}</p><button className="btn btn-primary" type="button" onClick={() => void loadWorkspace()}>{copy.tryAgain}</button></div>
              ) : messages.length === 0 ? (
                <div className="activity-empty"><span aria-hidden="true">↻</span><strong>{copy.noHistoryTitle}</strong><p>{copy.noHistoryBody}</p><button className="btn btn-primary" onClick={() => setPanel("prompts")}>{copy.browsePrompts}</button></div>
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
                <button className="btn btn-secondary" onClick={() => setPanel("account")}>{copy.viewAccount}</button>
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
              <article><span>{copy.workspacePreferences}</span><h2>{copy.languageAndRegion}</h2><p>{locale === "zh" ? copy.simplifiedChinese : copy.englishLanguage}</p><LanguageSwitcher locale={locale} locked={localeLocked} /></article>
              <article><span>{copy.privacyLabel}</span><h2>{copy.privateWorkspaceTitle}</h2><p>{copy.privateWorkspaceBody}</p><button onClick={() => setPanel("support")}>{copy.learnMore}</button></article>
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
                <button onClick={() => setPanel("prompts")}><strong>{copy.controlPrompts}</strong><small>{copy.promptsToolBody}</small><b aria-hidden="true">→</b></button>
                <button onClick={() => setPanel("usage")}><strong>{copy.controlUsage}</strong><small>{copy.usageToolBody}</small><b aria-hidden="true">→</b></button>
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
  delta: string
) {
  setMessages((prev) => {
    const next = [...prev];
    const lastIndex = next.length - 1;
    if (lastIndex >= 0 && next[lastIndex].role === "assistant") {
      next[lastIndex] = { ...next[lastIndex], content: next[lastIndex].content + delta };
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

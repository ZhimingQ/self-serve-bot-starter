"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { messages as translations, type Locale } from "../../lib/i18n";
import LanguageSwitcher from "../LanguageSwitcher";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

// White-label: the end-user must never see the reseller's raw upstream error text
// (e.g. an account billing/plan message), so any turn failure collapses to this.
// A chat error whose `message` is SAFE to display verbatim (our own friendly copy).
// Anything thrown that is NOT this (raw fetch/stream exceptions) is shown as the
// generic line instead, so implementation details never reach the end-user.
class ChatDisplayError extends Error {}

type ProvisionState = "checking" | "provisioning" | "ready" | "error";
type Panel = "overview" | "assistant" | "account";

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~2 minutes, covers the 30-90s cold-start window

export default function ChatApp({
  email,
  paid,
  paymentsEnabled,
  locale,
  localeLocked,
  brandName,
  brandLogoUrl,
  templateUrl,
  preview = false,
}: {
  email: string;
  paid: boolean;
  paymentsEnabled: boolean;
  locale: Locale;
  localeLocked: boolean;
  brandName: string;
  brandLogoUrl: string;
  templateUrl: string;
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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    setSending(true);

    if (preview) {
      window.setTimeout(() => {
        setLastAssistantMessage(setMessages, copy.demoChatResponse);
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

      reading: while (true) {
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
              break reading;
            }
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

  function openPrompt(prompt: string) {
    setInput(prompt);
    setPanel("assistant");
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

  return (
    <div className="control-shell">
      <aside className="control-sidebar">
        <div className="control-brand">
          {brandLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brandLogoUrl} alt="" />
          ) : <span aria-hidden="true" />}
          <strong>{brandName}</strong>
        </div>

        <nav className="control-nav" aria-label={copy.navigationLabel}>
          <button
            className={panel === "overview" ? "active" : ""}
            aria-current={panel === "overview" ? "page" : undefined}
            onClick={() => setPanel("overview")}
          >
            <span aria-hidden="true">⌂</span>{copy.controlOverview}
          </button>
          <button
            className={panel === "assistant" ? "active" : ""}
            aria-current={panel === "assistant" ? "page" : undefined}
            onClick={() => setPanel("assistant")}
          >
            <span aria-hidden="true">✦</span>{copy.controlAssistant}
          </button>
          <button
            className={panel === "account" ? "active" : ""}
            aria-current={panel === "account" ? "page" : undefined}
            onClick={() => setPanel("account")}
          >
            <span aria-hidden="true">○</span>{copy.controlAccount}
          </button>
        </nav>

        <div className="control-sidebar-account">
          <span>{copy.signedInAs}</span>
          <strong>{displayName}</strong>
          {preview && <em>{copy.previewMode}</em>}
        </div>
      </aside>

      <main className="control-main">
        <header className="control-topbar">
          <div>
            <span>{copy.workspace}</span>
            <strong>{panel === "overview" ? copy.controlOverview : panel === "assistant" ? copy.controlAssistant : copy.controlAccount}</strong>
          </div>
          <div className="control-topbar-actions">
            <span className="control-live"><i />{copy.onlineNow}</span>
            <LanguageSwitcher locale={locale} locked={localeLocked} />
          </div>
        </header>

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
              <div className="chat-messages">
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
                <div ref={messagesEndRef} />
              </div>
              <form className="chat-input-row" onSubmit={handleSend}>
                <input type="text" placeholder={copy.messagePlaceholder} value={input} onChange={(event) => setInput(event.target.value)} disabled={sending} />
                <button type="submit" className="btn btn-primary" disabled={sending || !input.trim()}>{copy.send}</button>
              </form>
            </div>
          </div>
        )}

        {panel === "account" && (
          <div className="control-content">
            <section className="control-heading"><span>{copy.accountEyebrow}</span><h1>{copy.accountTitle}</h1><p>{copy.accountSubtitle}</p></section>
            <section className="account-panel">
              <div><span>{copy.emailLabel}</span><strong>{email}</strong></div>
              <div><span>{copy.planLabel}</span><strong>{planName}</strong></div>
              <div><span>{copy.assistantAccessLabel}</span><strong><i className="status-dot" />{copy.activeAccess}</strong></div>
              {preview ? (
                <a className="btn btn-primary" href={templateUrl} target="_blank" rel="noopener noreferrer">{copy.getTemplate}</a>
              ) : (
                <button className="btn btn-secondary" onClick={handleLogout}>{copy.logout}</button>
              )}
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

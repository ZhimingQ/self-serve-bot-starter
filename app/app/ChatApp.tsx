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

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~2 minutes, covers the 30-90s cold-start window

export default function ChatApp({
  email,
  paid,
  paymentsEnabled,
  locale,
  localeLocked,
}: {
  email: string;
  paid: boolean;
  paymentsEnabled: boolean;
  locale: Locale;
  localeLocked: boolean;
}) {
  const copy = translations[locale];
  const router = useRouter();
  const needsPayment = paymentsEnabled && !paid;
  const [provisionState, setProvisionState] = useState<ProvisionState>("checking");
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    if (!needsPayment) provision();
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

  return (
    <div className="app-shell">
      <div className="app-topbar">
        <div className="assistant-identity">
          <span>{copy.privateAssistant}</span>
          <strong>{email}</strong>
        </div>
        <button className="btn btn-secondary" onClick={handleLogout}>
          {copy.logout}
        </button>
        <LanguageSwitcher locale={locale} locked={localeLocked} />
      </div>

      <div className="chat-window">
        <div className="chat-messages">
          {messages.length === 0 && (
            <p className="chat-empty">{copy.chatGreeting}</p>
          )}
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
          <input
            type="text"
            placeholder={copy.messagePlaceholder}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={sending}
          />
          <button type="submit" className="btn btn-primary" disabled={sending || !input.trim()}>
            {copy.send}
          </button>
        </form>
      </div>
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

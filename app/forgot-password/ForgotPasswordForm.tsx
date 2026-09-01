"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { messages, type Locale } from "../../lib/i18n";
import LanguageSwitcher from "../LanguageSwitcher";

/**
 * "Forgot password" — asks for an address and reports the same thing whatever
 * happens, because the server deliberately does not say whether the address has
 * an account. The one exception it renders differently is `not_configured`: the
 * storefront owner has not set up email, and telling the customer to wait for a
 * message that cannot arrive would be worse than pointing them at support.
 */
export default function ForgotPasswordForm({
  locale,
  localeLocked,
  emailConfigured,
  supportEmail,
}: {
  locale: Locale;
  localeLocked: boolean;
  emailConfigured: boolean;
  supportEmail: string;
}) {
  const copy = messages[locale];
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setState("sending");
    setError(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) { setState("sent"); return; }
      setState("error");
      setError(copy.resetSendFailed);
    } catch {
      setState("error");
      setError(copy.resetSendFailed);
    }
  }

  return (
    <div className="auth-shell">
      <aside className="auth-context">
        <div className="auth-context-top">
          <Link href="/login" className="auth-home">←</Link>
          <LanguageSwitcher locale={locale} locked={localeLocked} />
        </div>
        <span className="auth-context-mark">{copy.loginMark}</span>
        <div>
          <h2>{copy.forgotContextTitle}</h2>
          <p>{copy.forgotContextBody}</p>
        </div>
        <span className="auth-context-foot">{copy.loginContextFoot}</span>
      </aside>
      <div className="auth-form-side">
        <div className="auth-card">
          <p className="auth-kicker">{copy.forgotKicker}</p>
          <h1>{copy.forgotTitle}</h1>

          {!emailConfigured ? (
            <>
              <p className="hint">{copy.resetUnavailable}</p>
              {supportEmail && (
                <p className="auth-switch">
                  <a href={`mailto:${supportEmail}?subject=${encodeURIComponent(copy.resetSupportSubject)}`}>
                    {supportEmail}
                  </a>
                </p>
              )}
              <p className="auth-switch"><Link href="/login">{copy.backToLogin}</Link></p>
            </>
          ) : state === "sent" ? (
            <>
              <p className="hint">{copy.resetSent}</p>
              {/* The acknowledgement is deliberately non-committal, so a customer
                  whose email genuinely failed to send has no other signal. This
                  line is their way out — the server logs the failure, they ask,
                  and the owner runs `npm run reset-password`. */}
              {supportEmail && (
                <p className="hint">
                  {copy.resetSentSupport}{" "}
                  <a href={`mailto:${supportEmail}?subject=${encodeURIComponent(copy.resetSupportSubject)}`}>
                    {supportEmail}
                  </a>
                </p>
              )}
              <p className="auth-switch"><Link href="/login">{copy.backToLogin}</Link></p>
            </>
          ) : (
            <>
              <p className="hint">{copy.forgotHint}</p>
              {error && <div className="form-error" role="alert">{error}</div>}
              <form onSubmit={handleSubmit}>
                <div className="field">
                  <label htmlFor="email">{copy.email}</label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <button type="submit" className="btn btn-primary btn-block" disabled={state === "sending" || !email.trim()}>
                  {state === "sending" ? copy.resetSending : copy.resetSend}
                </button>
              </form>
              <p className="auth-switch"><Link href="/login">{copy.backToLogin}</Link></p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

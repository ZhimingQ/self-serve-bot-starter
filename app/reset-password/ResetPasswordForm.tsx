"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { messages, type Locale } from "../../lib/i18n";
import LanguageSwitcher from "../LanguageSwitcher";

/** Read `#token=…` written by the emailed link. Runs in the browser only — the
 *  fragment never reaches the server, which is exactly why the token lives
 *  there. */
function tokenFromHash(): string {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash.replace(/^#/, "");
  const value = new URLSearchParams(hash).get("token");
  return value ? value.trim() : "";
}

/**
 * Step 2 of the reset: choose a new password.
 *
 * On success this sends the customer to /login rather than signing them in. The
 * server does the same thing from its side (it rotates the session version, so
 * every old cookie is dead); typing the new password once is the confirmation
 * that the person who set it is the person using it.
 */
export default function ResetPasswordForm({
  locale,
  localeLocked,
  token: tokenFromQuery,
}: {
  locale: Locale;
  localeLocked: boolean;
  token: string;
}) {
  const copy = messages[locale];
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  // The token can only be read after hydration when it arrives in the fragment,
  // so `resolving` holds the "this link is no good" message back until we have
  // actually looked. Rendering that message first and correcting it a frame later
  // would tell a customer with a perfectly valid link that it is broken.
  const [token, setToken] = useState(tokenFromQuery);
  const [resolving, setResolving] = useState(!tokenFromQuery);

  useEffect(() => {
    if (tokenFromQuery) return;
    const read = () => { setToken(tokenFromHash()); setResolving(false); setError(null); };
    read();
    // Opening a second reset link in the same tab only changes the fragment, so
    // the browser does not remount anything. Without this the form would keep
    // submitting the FIRST token and reject a link that is perfectly valid.
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [tokenFromQuery]);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) { setError(copy.resetMismatch); return; }
    setState("saving");
    setError(null);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        setState("done");
        setTimeout(() => { router.push("/login"); router.refresh(); }, 1800);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setState("idle");
      setError(
        body.error === "invalid_token" ? copy.resetLinkExpired
        : body.error === "weak_password" ? copy.resetWeakPassword
        : body.error === "rate_limited" ? copy.resetRateLimited
        : copy.resetFailed,
      );
    } catch {
      setState("idle");
      setError(copy.resetFailed);
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
          <h2>{copy.resetContextTitle}</h2>
          <p>{copy.resetContextBody}</p>
        </div>
        <span className="auth-context-foot">{copy.loginContextFoot}</span>
      </aside>
      <div className="auth-form-side">
        <div className="auth-card">
          <p className="auth-kicker">{copy.forgotKicker}</p>
          <h1>{copy.resetTitle}</h1>

          {resolving ? (
            <p className="hint">{copy.resetChecking}</p>
          ) : !token ? (
            <>
              <p className="hint">{copy.resetNoToken}</p>
              <p className="auth-switch"><Link href="/forgot-password">{copy.forgotTitle}</Link></p>
            </>
          ) : state === "done" ? (
            <>
              <p className="hint">✓ {copy.resetDone}</p>
              <p className="auth-switch"><Link href="/login">{copy.backToLogin}</Link></p>
            </>
          ) : (
            <>
              <p className="hint">{copy.resetHint}</p>
              {error && <div className="form-error" role="alert">{error}</div>}
              <form onSubmit={handleSubmit}>
                <div className="field">
                  <label htmlFor="password">{copy.resetNewPassword}</label>
                  <input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {tooShort && <small className="form-error">{copy.resetWeakPassword}</small>}
                </div>
                <div className="field">
                  <label htmlFor="confirm">{copy.resetConfirmPassword}</label>
                  <input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                  {mismatch && <small className="form-error">{copy.resetMismatch}</small>}
                </div>
                <button
                  type="submit"
                  className="btn btn-primary btn-block"
                  disabled={state === "saving" || password.length < 8 || password !== confirm}
                >
                  {state === "saving" ? copy.resetSaving : copy.resetSave}
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

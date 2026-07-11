"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { messages, type Locale } from "../../lib/i18n";
import LanguageSwitcher from "../LanguageSwitcher";

export default function SignupForm({
  locale,
  localeLocked,
}: {
  locale: Locale;
  localeLocked: boolean;
}) {
  const copy = messages[locale];
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error === "demo_mode" ? copy.signupDisabled : copy.genericError);
      }
      router.push("/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.genericError);
      setLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <aside className="auth-context">
        <div className="auth-context-top">
          <Link href="/" className="auth-home">←</Link>
          <LanguageSwitcher locale={locale} locked={localeLocked} />
        </div>
        <span className="auth-context-mark">{copy.signupMark}</span>
        <div>
          <h2>{copy.signupContextTitle}</h2>
          <p>{copy.signupContextBody}</p>
        </div>
        <span className="auth-context-foot">{copy.signupContextFoot}</span>
      </aside>
      <div className="auth-form-side">
        <div className="auth-card">
          <p className="auth-kicker">{copy.getStarted}</p>
          <h1>{copy.createAccount}</h1>
          <p className="hint">{copy.signupHint}</p>
          {error && <div className="form-error" role="alert">{error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="email">{copy.email}</label>
              <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="password">{copy.password}</label>
              <input id="password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
              {loading ? copy.creatingAccount : copy.createAccount}
            </button>
          </form>
          <p className="auth-switch">{copy.alreadyAccount} <Link href="/login">{copy.login}</Link></p>
        </div>
      </div>
    </div>
  );
}

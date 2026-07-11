"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { messages, type Locale } from "../../lib/i18n";
import LanguageSwitcher from "../LanguageSwitcher";

export default function LoginForm({
  locale,
  localeLocked,
  signupHref,
}: {
  locale: Locale;
  localeLocked: boolean;
  signupHref: string;
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
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error(copy.invalidLogin);
      router.push("/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.invalidLogin);
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
        <span className="auth-context-mark">{copy.loginMark}</span>
        <div>
          <h2>{copy.loginContextTitle}</h2>
          <p>{copy.loginContextBody}</p>
        </div>
        <span className="auth-context-foot">{copy.loginContextFoot}</span>
      </aside>
      <div className="auth-form-side">
        <div className="auth-card">
          <p className="auth-kicker">{copy.welcomeBack}</p>
          <h1>{copy.login}</h1>
          <p className="hint">{copy.loginHint}</p>
          {error && <div className="form-error" role="alert">{error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="email">{copy.email}</label>
              <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="password">{copy.password}</label>
              <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
              {loading ? copy.loggingIn : copy.login}
            </button>
          </form>
          <p className="auth-switch">{copy.noAccount} <Link href={signupHref}>{copy.signUp}</Link></p>
        </div>
      </div>
    </div>
  );
}

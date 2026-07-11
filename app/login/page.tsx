"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function LoginPage() {
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
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Invalid email or password");
      }
      router.push("/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid email or password");
      setLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <aside className="auth-context">
        <span className="auth-context-mark">Continue the conversation</span>
        <div>
          <h2>Pick up right where you left off.</h2>
          <p>
            Your private assistant remembers the conversation, so your context is ready
            when you return.
          </p>
        </div>
        <span className="auth-context-foot">Private by default · Your context continues</span>
      </aside>

      <div className="auth-form-side">
        <div className="auth-card">
          <p className="auth-kicker">Welcome back</p>
          <h1>Log in</h1>
          <p className="hint">Continue chatting with your assistant.</p>

          {error && <div className="form-error">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
              {loading ? "Logging in…" : "Log in"}
            </button>
          </form>

          <p className="auth-switch">
            Don&apos;t have an account? <Link href="/signup">Sign up</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

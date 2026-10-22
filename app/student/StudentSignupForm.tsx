"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { schoolYears } from "../../lib/studentTutor";

const ERRORS: Record<string, string> = {
  demo_mode: "Sign-ups are turned off in this live demo.",
  rate_limited: "Too many sign-ups from this network. Please try again later.",
  invalid_school_year: "Please choose your school year from the list.",
  "A valid email is required": "Please enter a valid email address.",
  "Password must be between 8 and 200 characters": "Your password needs at least 8 characters.",
};

/** Sign-up for the student website: email, password and an optional school
 *  year that sets the tutor's level. Creating the account confirms the age
 *  terms in the line under the button; there is no age question, because a
 *  self-declared age proves nothing and the tutor treats every student as
 *  possibly under 18. */
export default function StudentSignupForm({ brandName }: { brandName: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [schoolYear, setSchoolYear] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          schoolYear: schoolYear || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          res.status === 409 ? "An account with this email already exists. Try logging in." :
          res.status === 429 ? ERRORS.rate_limited :
          ERRORS[String(data.error)] ?? "Something went wrong. Please try again.";
        setError(message);
        setLoading(false);
        return;
      }
      router.push("/app");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="st-auth">
      <Link href="/" className="st-auth-back">← {brandName}</Link>
      <div className="st-auth-card">
        <h1>Create your account</h1>
        <p className="st-auth-hint">Your tutor is ready about a minute after you sign up.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="schoolYear">School year <span className="st-optional">(optional)</span></label>
            <select id="schoolYear" value={schoolYear} onChange={(e) => setSchoolYear(e.target.value)}>
              <option value="">Choose your year</option>
              {schoolYears.map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}
            </select>
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? "Creating your account…" : "Create account"}
          </button>
          <p className="st-terms">
            By creating an account you confirm you&apos;re 13 or over and, if you&apos;re under 18, that a parent or guardian agrees.
          </p>
        </form>
        <p className="auth-switch">Already have an account? <Link href="/login">Log in</Link></p>
      </div>
    </div>
  );
}

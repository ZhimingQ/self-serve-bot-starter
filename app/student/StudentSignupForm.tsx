"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { schoolYears } from "../../lib/studentTutor";

type AgeChoice = "" | "under-13" | "13-17" | "18+";

const ERRORS: Record<string, string> = {
  demo_mode: "Sign-ups are turned off in this live demo.",
  rate_limited: "Too many sign-ups from this network. Please try again later.",
  under_13: "You need to be 13 or older to sign up.",
  age_required: "Please choose how old you are.",
  guardian_consent_required: "Please confirm a parent or guardian agrees before signing up.",
  invalid_school_year: "Please choose your school year from the list.",
  "A valid email is required": "Please enter a valid email address.",
  "Password must be between 8 and 200 characters": "Your password needs at least 8 characters.",
};

/** Sign-up for the student website: email and password, plus the age check
 *  our terms require (13 and over, a parent or guardian's consent under 18)
 *  and an optional school year that sets the tutor's level. The server checks
 *  the same rules; this form only explains them. */
export default function StudentSignupForm({ brandName }: { brandName: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [age, setAge] = useState<AgeChoice>("");
  const [consent, setConsent] = useState(false);
  const [schoolYear, setSchoolYear] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const tooYoung = age === "under-13";
  const needsConsent = age === "13-17";
  const canSubmit = !loading && age !== "" && !tooYoung && (!needsConsent || consent);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) {
      if (age === "") setError(ERRORS.age_required);
      else if (needsConsent && !consent) setError(ERRORS.guardian_consent_required);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ageBand: age,
          guardianConsent: needsConsent ? consent : false,
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

          <fieldset className="st-age">
            <legend>How old are you?</legend>
            <div className="st-age-options">
              {([
                ["under-13", "Under 13"],
                ["13-17", "13 to 17"],
                ["18+", "18 or over"],
              ] as const).map(([value, label]) => (
                <label key={value} className={age === value ? "is-selected" : ""}>
                  <input
                    type="radio"
                    name="ageBand"
                    value={value}
                    checked={age === value}
                    onChange={() => { setAge(value); setError(null); }}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          {tooYoung && (
            <div className="st-notice" role="status">
              Sorry, you need to be 13 or older to use {brandName}. Ask a parent, guardian or teacher about other ways to get help with your work.
            </div>
          )}

          {needsConsent && (
            <label className="st-consent">
              <input type="checkbox" checked={consent} onChange={(e) => { setConsent(e.target.checked); setError(null); }} />
              <span>My parent or guardian knows I&apos;m signing up and agrees to it.</span>
            </label>
          )}

          {!tooYoung && (
            <div className="field">
              <label htmlFor="schoolYear">School year <span className="st-optional">(optional)</span></label>
              <select id="schoolYear" value={schoolYear} onChange={(e) => setSchoolYear(e.target.value)}>
                <option value="">Choose your year</option>
                {schoolYears.map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}
              </select>
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={loading || tooYoung}>
            {loading ? "Creating your account…" : "Create account"}
          </button>
        </form>
        <p className="auth-switch">Already have an account? <Link href="/login">Log in</Link></p>
      </div>
    </div>
  );
}

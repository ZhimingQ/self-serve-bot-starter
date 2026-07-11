import Link from "next/link";
import { brand, demoMode, demoSignupUrl } from "../lib/config";

export default function LandingPage() {
  // In demo mode the sign-up / log-in flows are disabled (this is a public
  // showcase), so every CTA points at the real product instead — and opens in a
  // new tab, since the demo itself is the thing being shown off.
  const primaryHref = demoMode ? demoSignupUrl : "/signup";
  const secondaryHref = demoMode ? demoSignupUrl : "/login";
  const ctaProps = demoMode ? { target: "_blank", rel: "noopener noreferrer" } : {};

  return (
    <>
      {demoMode && (
        <div
          style={{
            background: "var(--accent, #4f46e5)",
            color: "#fff",
            textAlign: "center",
            fontSize: 13.5,
            padding: "9px 16px",
            lineHeight: 1.5,
          }}
        >
          You&rsquo;re viewing a live demo of the Self-Serve Bot storefront template.{" "}
          <a
            href={demoSignupUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#fff", fontWeight: 600, textDecoration: "underline" }}
          >
            Get this template on OpenClaw Launch →
          </a>
        </div>
      )}

      <nav className="nav">
        <Link href="/" className="brand">
          <span className="brand-dot" />
          {brand.name}
        </Link>
        <div className="nav-actions">
          <Link href={secondaryHref} className="btn btn-secondary" {...ctaProps}>
            Log in
          </Link>
          <Link href={primaryHref} className="btn btn-primary" {...ctaProps}>
            Get started
          </Link>
        </div>
      </nav>

      <main className="hero">
        <div className="hero-inner">
          <span className="eyebrow">Your own AI, in seconds</span>
          <h1>Your own AI assistant, ready in seconds</h1>
          <p className="subtitle">
            Sign up and {brand.name} spins up a private AI assistant just for you — no
            setup, no waiting around, no shared bot. Just sign up and start chatting.
          </p>
          <div className="hero-ctas">
            <Link href={primaryHref} className="btn btn-primary" {...ctaProps}>
              Get your assistant
            </Link>
            <Link href={secondaryHref} className="btn btn-secondary" {...ctaProps}>
              I already have an account
            </Link>
          </div>
        </div>
      </main>

      <section className="features">
        <div className="feature-card">
          <h3>Your own bot</h3>
          <p>Every account gets its own dedicated assistant — never shared, never mixed up.</p>
        </div>
        <div className="feature-card">
          <h3>Remembers your conversations</h3>
          <p>Multi-turn memory means you can pick up right where you left off.</p>
        </div>
        <div className="feature-card">
          <h3>Live in under a minute</h3>
          <p>No install, no config. Sign up and your assistant is ready to chat.</p>
        </div>
      </section>

      <footer className="site-footer">
        © {new Date().getFullYear()} {brand.name}. All rights reserved.
      </footer>
    </>
  );
}

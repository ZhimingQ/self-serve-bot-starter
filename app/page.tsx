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
        <div className="demo-banner">
          You&rsquo;re viewing a live demo of the Self-Serve Bot website template.{" "}
          <a
            href={demoSignupUrl}
            target="_blank"
            rel="noopener noreferrer"
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

      <main className="landing-main">
        <section className="hero">
          <div className="hero-inner">
            <span className="eyebrow">Your own AI, in seconds</span>
            <h1>
              Your own AI assistant, <em>ready in seconds.</em>
            </h1>
            <p className="subtitle">
              Sign up and {brand.name} spins up a private AI assistant just for you — no
              setup, no waiting around, no shared bot. Just sign up and start chatting.
            </p>
            <div className="hero-ctas">
              <Link href={primaryHref} className="btn btn-primary" {...ctaProps}>
                Get your assistant <span aria-hidden="true">→</span>
              </Link>
              <Link href={secondaryHref} className="text-link" {...ctaProps}>
                I already have an account
              </Link>
            </div>
          </div>

          <div className="product-preview" aria-label="Example assistant conversation">
            <div className="preview-header">
              <div>
                <span className="preview-kicker">Private assistant</span>
                <strong>Your conversation</strong>
              </div>
              <span className="online-status">● Online</span>
            </div>
            <div className="preview-messages">
              <div className="preview-message preview-assistant">
                <span>Assistant</span>
                <p>Hello. What would you like to work through today?</p>
              </div>
              <div className="preview-message preview-user">
                <span>You</span>
                <p>Turn my meeting notes into a concise project plan.</p>
              </div>
              <div className="preview-message preview-memory">
                <span>Assistant · remembers context</span>
                <p>I&rsquo;ll organize the decisions, owners, deadlines, and open questions.</p>
              </div>
            </div>
            <div className="preview-composer">
              <span>Message your assistant…</span>
              <span className="preview-send" aria-hidden="true">↑</span>
            </div>
          </div>
        </section>

        <section className="features" aria-label="Product benefits">
          <div className="feature-card">
            <span className="feature-number">01</span>
            <h3>Your own bot</h3>
            <p>Every account gets its own dedicated assistant — never shared, never mixed up.</p>
          </div>
          <div className="feature-card">
            <span className="feature-number">02</span>
            <h3>Remembers your conversations</h3>
            <p>Multi-turn memory means you can pick up right where you left off.</p>
          </div>
          <div className="feature-card">
            <span className="feature-number">03</span>
            <h3>Live in under a minute</h3>
            <p>No install, no config. Sign up and your assistant is ready to chat.</p>
          </div>
        </section>

        <section className="closing-cta">
          <div>
            <span className="eyebrow">Ready when you are</span>
            <h2>A clearer next step is one conversation away.</h2>
          </div>
          <Link href={primaryHref} className="btn btn-inverse" {...ctaProps}>
            Get your assistant <span aria-hidden="true">→</span>
          </Link>
        </section>
      </main>

      <footer className="site-footer">
        <Link href="/" className="footer-brand">
          <span className="brand-dot" />
          {brand.name}
        </Link>
        <span>© {new Date().getFullYear()} {brand.name}. All rights reserved.</span>
      </footer>
    </>
  );
}

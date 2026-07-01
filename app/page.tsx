import Link from "next/link";
import { brand } from "@/lib/config";

export default function LandingPage() {
  return (
    <>
      <nav className="nav">
        <Link href="/" className="brand">
          <span className="brand-dot" />
          {brand.name}
        </Link>
        <div className="nav-actions">
          <Link href="/login" className="btn btn-secondary">
            Log in
          </Link>
          <Link href="/signup" className="btn btn-primary">
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
            <Link href="/signup" className="btn btn-primary">
              Get your assistant
            </Link>
            <Link href="/login" className="btn btn-secondary">
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

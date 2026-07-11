import Link from "next/link";
import { brand, demoMode, demoSignupUrl } from "../lib/config";
import { messages } from "../lib/i18n";
import { getLocaleState } from "../lib/locale";
import LanguageSwitcher from "./LanguageSwitcher";

export default async function LandingPage() {
  const { locale, locked } = await getLocaleState();
  const copy = messages[locale];
  // Demo mode blocks public signup/provisioning, so its primary CTAs lead
  // existing demo users into the working login/chat flow. The banner below is
  // the only marketplace link.
  const primaryHref = demoMode ? "/login" : "/signup";

  return (
    <>
      {demoMode && (
        <div className="demo-banner">
          {copy.demo}{" "}
          <a
            href={demoSignupUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy.demoCta}
          </a>
        </div>
      )}

      <nav className="nav">
        <Link href="/" className="brand">
          <span className="brand-dot" />
          {brand.name}
        </Link>
        <div className="nav-actions">
          <LanguageSwitcher locale={locale} locked={locked} />
          <Link href="/login" className="btn btn-secondary">
            {copy.login}
          </Link>
          <Link href={primaryHref} className="btn btn-primary">
            {copy.getStarted}
          </Link>
        </div>
      </nav>

      <main className="landing-main">
        <section className="hero">
          <div className="hero-inner">
            <span className="eyebrow">{copy.heroEyebrow}</span>
            <h1>
              {copy.heroTitle} <em>{copy.heroEmphasis}</em>
            </h1>
            <p className="subtitle">
              {copy.heroBody(brand.name)}
            </p>
            <div className="hero-ctas">
              <Link href={primaryHref} className="btn btn-primary">
                {copy.getAssistant} <span aria-hidden="true">→</span>
              </Link>
              <Link href="/login" className="text-link">
                {copy.haveAccount}
              </Link>
            </div>
          </div>

          <div className="product-preview" aria-label={copy.yourConversation}>
            <div className="preview-header">
              <div>
                <span className="preview-kicker">{copy.privateAssistant}</span>
                <strong>{copy.yourConversation}</strong>
              </div>
              <span className="online-status">{copy.online}</span>
            </div>
            <div className="preview-messages">
              <div className="preview-message preview-assistant">
                <span>{copy.assistant}</span>
                <p>{copy.previewAssistant}</p>
              </div>
              <div className="preview-message preview-user">
                <span>{copy.you}</span>
                <p>{copy.previewUser}</p>
              </div>
              <div className="preview-message preview-memory">
                <span>{copy.remembersContext}</span>
                <p>{copy.previewMemory}</p>
              </div>
            </div>
            <div className="preview-composer">
              <span>{copy.messagePlaceholder}</span>
              <span className="preview-send" aria-hidden="true">↑</span>
            </div>
          </div>
        </section>

        <section className="features" aria-label={copy.benefitsLabel}>
          <div className="feature-card">
            <span className="feature-number">01</span>
            <h3>{copy.feature1Title}</h3>
            <p>{copy.feature1Body}</p>
          </div>
          <div className="feature-card">
            <span className="feature-number">02</span>
            <h3>{copy.feature2Title}</h3>
            <p>{copy.feature2Body}</p>
          </div>
          <div className="feature-card">
            <span className="feature-number">03</span>
            <h3>{copy.feature3Title}</h3>
            <p>{copy.feature3Body}</p>
          </div>
        </section>

        <section className="closing-cta">
          <div>
            <span className="eyebrow">{copy.readyEyebrow}</span>
            <h2>{copy.readyTitle}</h2>
          </div>
          <Link href={primaryHref} className="btn btn-inverse">
            {copy.getAssistant} <span aria-hidden="true">→</span>
          </Link>
        </section>
      </main>

      <footer className="site-footer">
        <Link href="/" className="footer-brand">
          <span className="brand-dot" />
          {brand.name}
        </Link>
        <span>© {new Date().getFullYear()} {brand.name}. {copy.rights}</span>
      </footer>
    </>
  );
}

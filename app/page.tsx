import Link from "next/link";
import { brand, demoMode, demoSignupUrl, paymentsEnabled, stripe } from "../lib/config";
import { messages } from "../lib/i18n";
import { getLocaleState } from "../lib/locale";
import { getOfferKind } from "../lib/offer";
import LanguageSwitcher from "./LanguageSwitcher";

export default async function LandingPage() {
  const { locale, locked } = await getLocaleState();
  const copy = messages[locale];
  // Demo mode blocks public signup/provisioning. Keep login available for
  // existing demo users, while the primary marketing path takes new visitors
  // to the template instead of dropping them onto a login dead end.
  const primaryHref = demoMode ? "/demo" : "/signup";
  const primaryLabel = demoMode
    ? copy.demoPrimary
    : paymentsEnabled
      ? copy.createToContinue
      : copy.startFree;
  const offerKind = getOfferKind({ demoMode, paymentsEnabled, stripeMode: stripe.mode });
  const defaultPricing = {
    demo: [copy.pricingDemo, copy.pricingDemoBody],
    free: [copy.pricingFree, copy.pricingFreeBody],
    payment: [copy.pricingOneTime, copy.pricingOneTimeBody],
    subscription: [copy.pricingSubscription, copy.pricingPaidBody],
  }[offerKind];
  const priceLabel = brand.priceLabel || defaultPricing[0];
  const priceNote = brand.priceNote || defaultPricing[1];

  function PrimaryAction({ className }: { className: string }) {
    const content = <>{primaryLabel} <span aria-hidden="true">→</span></>;
    return <Link href={primaryHref} className={className}>{content}</Link>;
  }

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
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt="" className="brand-logo" />
          ) : <span className="brand-dot" />}
          {brand.name}
        </Link>
        <div className="nav-actions">
          <LanguageSwitcher locale={locale} locked={locked} />
          <Link href="/login" className="btn btn-secondary">
            {copy.login}
          </Link>
          <PrimaryAction className="btn btn-primary" />
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
              <PrimaryAction className="btn btn-primary" />
              <Link href="/login" className="text-link">
                {copy.haveAccount}
              </Link>
            </div>
            <div className="hero-proof" aria-label={copy.benefitsLabel}>
              <span>{copy.proofPrivate}</span>
              <span>{copy.proofMemory}</span>
              <span>{copy.proofFast}</span>
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

        <section className="use-cases">
          <div className="section-heading">
            <span className="eyebrow">{copy.useCasesEyebrow}</span>
            <h2>{copy.useCasesTitle}</h2>
            <p>{copy.useCasesBody}</p>
          </div>
          <div className="use-case-grid">
            <article className="use-case-card">
              <span>{copy.useCase1Kicker}</span>
              <h3>{copy.useCase1Title}</h3>
              <p>{copy.useCase1Body}</p>
            </article>
            <article className="use-case-card">
              <span>{copy.useCase2Kicker}</span>
              <h3>{copy.useCase2Title}</h3>
              <p>{copy.useCase2Body}</p>
            </article>
            <article className="use-case-card">
              <span>{copy.useCase3Kicker}</span>
              <h3>{copy.useCase3Title}</h3>
              <p>{copy.useCase3Body}</p>
            </article>
          </div>
        </section>

        <section className="how-section">
          <div className="section-heading section-heading-light">
            <span className="eyebrow">{copy.howEyebrow}</span>
            <h2>{copy.howTitle}</h2>
            <p>{copy.howBody}</p>
          </div>
          <div className="how-steps">
            <article><span>01</span><div><h3>{copy.howStep1Title}</h3><p>{copy.howStep1Body}</p></div></article>
            <article><span>02</span><div><h3>{copy.howStep2Title}</h3><p>{copy.howStep2Body}</p></div></article>
            <article><span>03</span><div><h3>{copy.howStep3Title}</h3><p>{copy.howStep3Body}</p></div></article>
          </div>
        </section>

        <section className="pricing-section">
          <div className="section-heading">
            <span className="eyebrow">{copy.pricingEyebrow}</span>
            <h2>{copy.pricingTitle}</h2>
          </div>
          <div className="pricing-card">
            <div>
              <span className="pricing-label">{priceLabel}</span>
              <p>{priceNote}</p>
              <PrimaryAction className="btn btn-primary" />
            </div>
            <div className="pricing-includes">
              <strong>{copy.pricingIncludes}</strong>
              <span>{copy.pricingItem1}</span>
              <span>{copy.pricingItem2}</span>
              <span>{copy.pricingItem3}</span>
            </div>
          </div>
        </section>

        <section className="faq-section">
          <div className="section-heading">
            <span className="eyebrow">{copy.faqEyebrow}</span>
            <h2>{copy.faqTitle}</h2>
          </div>
          <div className="faq-list">
            <details><summary>{copy.faq1Question}</summary><p>{copy.faq1Answer}</p></details>
            <details><summary>{copy.faq2Question}</summary><p>{copy.faq2Answer}</p></details>
            <details><summary>{copy.faq3Question}</summary><p>{copy.faq3Answer}</p></details>
            <details><summary>{copy.faq4Question}</summary><p>{copy.faq4Answer}</p></details>
          </div>
        </section>

        <section className="closing-cta">
          <div>
            <span className="eyebrow">{copy.readyEyebrow}</span>
            <h2>{copy.readyTitle}</h2>
          </div>
          <PrimaryAction className="btn btn-inverse" />
        </section>
      </main>

      <footer className="site-footer">
        <Link href="/" className="footer-brand">
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt="" className="brand-logo" />
          ) : <span className="brand-dot" />}
          {brand.name}
        </Link>
        <div className="footer-meta">
          <nav className="footer-links" aria-label={copy.footerLabel}>
            {brand.supportEmail && <a href={`mailto:${brand.supportEmail}`}>{copy.support}</a>}
            {brand.privacyUrl && <a href={brand.privacyUrl}>{copy.privacy}</a>}
            {brand.termsUrl && <a href={brand.termsUrl}>{copy.terms}</a>}
          </nav>
          <span>© {new Date().getFullYear()} {brand.name}. {copy.rights}</span>
        </div>
      </footer>
    </>
  );
}

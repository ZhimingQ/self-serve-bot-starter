import Link from "next/link";
import { brand, demoMode, paymentsEnabled, stripe } from "../../lib/config";
import { messages } from "../../lib/i18n";
import { getOfferKind } from "../../lib/offer";

/** The brand mark: the owner's logo, or the first letter of the name on the
 *  accent colour. */
export function StudentBrandMark({ size = "md" }: { size?: "sm" | "md" }) {
  if (brand.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={brand.logoUrl} alt="" className={`st-mark st-mark-${size} st-mark-img`} />;
  }
  const letter = Array.from(brand.name.trim())[0]?.toUpperCase() || "S";
  return <span className={`st-mark st-mark-${size}`} aria-hidden="true">{letter}</span>;
}

/**
 * The landing page of the student website (WORKSPACE_MODE=students): says
 * plainly what the tutor does and does not do, and shows one example answer
 * with its sources. English only.
 */
export default function StudentLanding() {
  const copy = messages.en;
  const primaryHref = demoMode ? "/demo" : "/signup";
  const offerKind = getOfferKind({ demoMode, paymentsEnabled, stripeMode: stripe.mode });
  const defaultPrice = {
    demo: "",
    free: "Free to use",
    payment: copy.pricingOneTime,
    subscription: copy.pricingSubscription,
  }[offerKind];
  const priceLine = [brand.priceLabel || defaultPrice, brand.priceNote].filter(Boolean).join(" · ");

  return (
    <div className="st-landing">
      {demoMode && (
        <div className="demo-banner">
          {copy.demo}
        </div>
      )}
      <nav className="st-nav">
        <Link href="/" className="st-brand">
          <StudentBrandMark />
          <span>{brand.name}</span>
        </Link>
        <div className="st-nav-actions">
          <Link href="/login" className="btn btn-secondary">Log in</Link>
          <Link href={primaryHref} className="btn btn-primary">Sign up</Link>
        </div>
      </nav>

      <main>
        <section className="st-hero">
          <div className="st-hero-copy">
            <p className="st-kicker">For GCSE and A-level coursework</p>
            <h1>Research your coursework with a tutor that shows its sources.</h1>
            <p className="st-lead">
              Ask about any topic, get it explained in plain English, and get links to reliable sources you can check and cite.
            </p>
            <div className="st-ctas">
              <Link href={primaryHref} className="btn btn-primary st-cta">Start researching</Link>
              <Link href="/login" className="btn btn-secondary st-cta">Log in</Link>
            </div>
            {priceLine && <p className="st-price">{priceLine}</p>}
            <ul className="st-points">
              <li><span className="st-yes" aria-hidden="true">✓</span>Explains topics step by step, at your level</li>
              <li><span className="st-yes" aria-hidden="true">✓</span>Finds sources and links every one</li>
              <li><span className="st-yes" aria-hidden="true">✓</span>Helps you plan and check your own writing</li>
            </ul>
          </div>

          <figure className="st-example" aria-label="Example answer">
            <figcaption>Example</figcaption>
            <p className="st-bubble st-bubble-user">What were the main causes of the First World War?</p>
            <div className="st-bubble st-bubble-tutor">
              <p>
                Historians often group the long-term causes as <strong>MAIN</strong>: militarism, alliances, imperialism and nationalism <span className="st-cite">1</span>. The assassination of Archduke Franz Ferdinand in June 1914 was the trigger that turned these tensions into war <span className="st-cite">2</span>.
              </p>
              <div className="st-sources">
                <span><span className="st-cite">1</span>BBC Bitesize · Causes of World War One</span>
                <span><span className="st-cite">2</span>Imperial War Museums · How the assassination led to war</span>
              </div>
            </div>
          </figure>
        </section>
      </main>

      <footer className="st-footer">
        <span>© {new Date().getFullYear()} {brand.name}</span>
        <nav aria-label={copy.footerLabel}>
          {brand.websiteUrl && <a href={brand.websiteUrl} target="_blank" rel="noopener noreferrer">{copy.website}</a>}
          {brand.supportEmail && <a href={`mailto:${brand.supportEmail}`}>{copy.support}</a>}
          {brand.privacyUrl && <a href={brand.privacyUrl}>{copy.privacy}</a>}
          {brand.termsUrl && <a href={brand.termsUrl}>{copy.terms}</a>}
        </nav>
      </footer>
    </div>
  );
}

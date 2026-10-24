import Link from "next/link";
import {
  allowChannelConnect,
  allowEndUserByok,
  brand,
  demoMode,
  demoSignupUrl,
  enabledBotTools,
  offeredChannels,
  paymentsEnabled,
  stripe,
  studentWorkspace,
} from "../lib/config";
import { joinNames, landingChannels, landingTools, type LandingChannel, type LandingTool } from "../lib/landingFeatures";
import StudentLanding from "./student/StudentLanding";
import { messages } from "../lib/i18n";
import { getLocaleState } from "../lib/locale";
import { getOfferKind } from "../lib/offer";
import LanguageSwitcher from "./LanguageSwitcher";

export default async function LandingPage() {
  // WORKSPACE_MODE=students has its own landing page.
  if (studentWorkspace) return <StudentLanding />;
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
  const l = copy.landing;

  // Only what this storefront really offers (see lib/landingFeatures.ts).
  const channels = landingChannels({
    offered: offeredChannels,
    framework: brand.framework,
    connectEnabled: allowChannelConnect,
    locale,
  });
  const channelNames = channels.map((id) => copy.channelName[id]);
  const firstChannel = channelNames[0] ?? "";
  const tools = landingTools({ tools: enabledBotTools, byok: allowEndUserByok });
  const demo = firstChannel ? l.scheduled : l.draft;
  const jobs = [
    l.write,
    l.research,
    firstChannel ? { ...l.automate, result: l.automate.result(firstChannel) } : l.remember,
  ];

  // `compact` is for the nav, which has to sit a brand name of up to 60
  // characters next to this button on a 390px screen. Both labels are rendered
  // and CSS hides one, so the swap needs no JavaScript and survives static
  // rendering; only the visible one is in the accessibility tree.
  function PrimaryAction({ className, compact = false }: { className: string; compact?: boolean }) {
    const content = compact ? (
      <>
        <span className="cta-label-full">{primaryLabel}</span>
        <span className="cta-label-compact">{copy.getStarted}</span>
        {" "}<span aria-hidden="true">→</span>
      </>
    ) : (
      <>{primaryLabel} <span aria-hidden="true">→</span></>
    );
    return <Link href={primaryHref} className={className}>{content}</Link>;
  }

  return (
    <div className="landing">
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
          <span className="brand-name">{brand.name}</span>
        </Link>
        <div className="landing-nav-links">
          <a href="#what-it-does">{l.nav.does}</a>
          {tools.length > 0 && <a href="#tools">{l.nav.tools}</a>}
          <a href="#pricing">{l.nav.pricing}</a>
          <a href="#faq">{l.nav.faq}</a>
        </div>
        <div className="nav-actions">
          <LanguageSwitcher locale={locale} locked={locked} />
          <Link href="/login" className="btn btn-secondary">
            {copy.login}
          </Link>
          <PrimaryAction className="btn btn-primary" compact />
        </div>
      </nav>

      <main className="landing-main">
        <section className="hero">
          <div className="hero-inner">
            <span className="eyebrow">{copy.heroEyebrow}</span>
            <h1>{copy.heroTitle}</h1>
            <p className="subtitle">
              {copy.heroBody(brand.name, joinNames(channelNames, l.list, 2))}
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

          {/* An example, labelled as one. The scheduled job only appears when a
              chat app can be connected: a job's result has to arrive somewhere,
              and the browser chat cannot push it to someone who is away. */}
          <figure className="product-preview landing-demo" aria-label={l.exampleCaption}>
            <div className="preview-header">
              <div>
                <span className="preview-kicker">{copy.privateAssistant}</span>
                <strong>{brand.name}</strong>
              </div>
              <span className="online-status">{firstChannel ? l.via(firstChannel) : copy.online}</span>
            </div>
            <div className="preview-messages">
              <div className="preview-message preview-user">
                <span>{copy.you}</span>
                <p>{demo.user}</p>
              </div>
              <div className="preview-message preview-assistant">
                <span>{copy.assistant}</span>
                <p>{demo.assistant}</p>
                <div className="landing-demo-result">
                  <strong>{demo.resultTitle}</strong>
                  <ol>
                    <li>{demo.result1}</li>
                    <li>{demo.result2}</li>
                  </ol>
                </div>
                {"tag" in demo && <span className="landing-demo-tag">{demo.tag}</span>}
              </div>
            </div>
            <div className="preview-composer" aria-hidden="true">
              <span>{copy.messagePlaceholder}</span>
              <span className="preview-send">↑</span>
            </div>
            <figcaption>{l.exampleCaption}</figcaption>
          </figure>
        </section>

        {channels.length > 0 && (
          <section className="landing-channels" aria-label={l.channelsLabel}>
            <span>{l.channelsLead}</span>
            <ul>
              {channels.map((id) => (
                <li key={id}><i style={{ background: CHANNEL_COLOR[id] }} aria-hidden="true" />{copy.channelName[id]}</li>
              ))}
            </ul>
            <span>{l.channelsTail}</span>
          </section>
        )}

        <section className="use-cases" id="what-it-does">
          <div className="section-heading">
            <span className="eyebrow">{l.doesEyebrow}</span>
            <h2>{l.doesTitle}</h2>
            <p>{l.doesBody}</p>
          </div>
          <div className="use-case-grid">
            {jobs.map((job) => (
              <article className="use-case-card" key={job.kicker}>
                <span>{job.kicker}</span>
                <h3>{job.title}</h3>
                <p className="landing-job-prompt">{job.prompt}</p>
                <p className="landing-job-result">{job.result}</p>
              </article>
            ))}
          </div>
        </section>

        {tools.length > 0 && (
          <section className="landing-tools" id="tools">
            <div className="section-heading">
              <span className="eyebrow">{l.toolsEyebrow}</span>
              <h2>{l.toolsTitle}</h2>
              <p>{l.toolsBody}</p>
            </div>
            <ul className="landing-tool-grid">
              {tools.map((tool) => {
                const text = tool.id === "backup"
                  ? l.tools[tool.variant === "both" ? "backupBoth" : tool.variant]
                  : l.tools[tool.id];
                return (
                  <li key={tool.id}>
                    <ToolIcon id={tool.id} />
                    <strong>{text.title}</strong>
                    <span>{text.body}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="pricing-section" id="pricing">
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

        <section className="faq-section" id="faq">
          <div className="section-heading">
            <span className="eyebrow">{copy.faqEyebrow}</span>
            <h2>{copy.faqTitle}</h2>
          </div>
          <div className="faq-list">
            <details><summary>{copy.faq1Question}</summary><p>{copy.faq1Answer}</p></details>
            {channels.length > 0 && (
              <details><summary>{l.faqChannelsQuestion}</summary><p>{l.faqChannelsAnswer(joinNames(channelNames, l.list))}</p></details>
            )}
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
            {brand.websiteUrl && <a href={brand.websiteUrl} target="_blank" rel="noopener noreferrer">{copy.website}</a>}
            {brand.supportEmail && <a href={`mailto:${brand.supportEmail}`}>{copy.support}</a>}
            {brand.privacyUrl && <a href={brand.privacyUrl}>{copy.privacy}</a>}
            {brand.termsUrl && <a href={brand.termsUrl}>{copy.terms}</a>}
          </nav>
          <span>© {new Date().getFullYear()} {brand.name}. {copy.rights}</span>
        </div>
      </footer>
    </div>
  );
}

// Brand colours of the chat apps, used only for the small dot beside each name.
const CHANNEL_COLOR: Record<LandingChannel, string> = {
  telegram: "#229ED9",
  whatsapp: "#25D366",
  discord: "#5865F2",
  slack: "#4A154B",
  wechat: "#07C160",
  feishu: "#3370FF",
};

// Simple line icons, drawn in the reseller's accent by the surrounding CSS.
const TOOL_ICON_PATHS: Record<LandingTool["id"], string> = {
  desktop: "M3 5h18v11H3z M8 20h8 M12 16v4",
  files: "M3 7h6l2 2h10v10H3z",
  computer: "M4 6h16v10H4z M2 19h20",
  video: "M3 6h13v12H3z M16 10l5-3v10l-5-3",
  ssh: "M3 5h18v14H3z M7 10l3 2-3 2 M12 15h5",
  endpoint: "M8 7l-5 5 5 5 M16 7l5 5-5 5",
  backup: "M12 3v12 M7 10l5 5 5-5 M4 20h16",
  power: "M12 3v8 M6.3 7.5a8 8 0 1 0 11.4 0",
  byok: "M14 10a4 4 0 1 0-1 1l7 7 M17 15l2-2",
};

function ToolIcon({ id }: { id: LandingTool["id"] }) {
  return (
    <svg className="landing-tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={TOOL_ICON_PATHS[id]} />
    </svg>
  );
}

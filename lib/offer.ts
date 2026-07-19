export type OfferKind = "demo" | "free" | "payment" | "subscription";

interface OfferConfig {
  demoMode: boolean;
  paymentsEnabled: boolean;
  stripeMode: "payment" | "subscription";
}

/** Selects customer-facing pricing language without exposing payment secrets. */
export function getOfferKind(config: OfferConfig): OfferKind {
  if (config.demoMode) return "demo";
  if (!config.paymentsEnabled) return "free";
  return config.stripeMode;
}

export type BillingMode = "subscription" | "payment";

type IdReference = string | { id?: string | null } | null | undefined;

export function stripeReferenceId(value: IdReference): string {
  return typeof value === "string" ? value : value?.id || "";
}

/** Paid storefront access requires evidence that Stripe collected real money. */
export function isFundedCheckoutSession(session: {
  payment_status?: string | null;
  amount_total?: number | null;
}): boolean {
  return session.payment_status === "paid" && (session.amount_total ?? 0) > 0;
}

export function isFundedInvoice(invoice: { amount_paid?: number | null }): boolean {
  return (invoice.amount_paid ?? 0) > 0;
}

function checkoutPriceIds(session: {
  line_items?: { data?: Array<{ price?: IdReference }> } | null;
}): string[] {
  return (session.line_items?.data || []).map((line) => stripeReferenceId(line.price)).filter(Boolean);
}

/** Bind a Checkout event to the exact offer created by this storefront. */
export function checkoutMatchesOffer(
  session: {
    mode?: string | null;
    metadata?: Record<string, string> | null;
    line_items?: { data?: Array<{ price?: IdReference }> } | null;
  },
  priceId: string,
  mode: BillingMode
): boolean {
  return session.mode === mode &&
    session.metadata?.storefrontPriceId === priceId &&
    session.metadata?.storefrontBillingMode === mode &&
    checkoutPriceIds(session).includes(priceId);
}

export function isFundedStorefrontCheckout(
  session: Parameters<typeof checkoutMatchesOffer>[0] & {
    payment_status?: string | null;
    amount_total?: number | null;
  },
  priceId: string,
  mode: BillingMode
): boolean {
  return isFundedCheckoutSession(session) && checkoutMatchesOffer(session, priceId, mode);
}

export function invoiceSubscriptionId(invoice: {
  subscription?: IdReference;
  parent?: { subscription_details?: { subscription?: IdReference } | null } | null;
}): string {
  return stripeReferenceId(invoice.parent?.subscription_details?.subscription) ||
    stripeReferenceId(invoice.subscription);
}

function invoicePriceIds(invoice: {
  lines?: { data?: Array<{
    price?: IdReference;
    pricing?: { price_details?: { price?: IdReference } | null } | null;
  }> } | null;
}): string[] {
  return (invoice.lines?.data || []).flatMap((line) => {
    const modern = stripeReferenceId(line.pricing?.price_details?.price);
    const legacy = stripeReferenceId(line.price);
    return [modern, legacy].filter(Boolean);
  });
}

/** Bind a recurring invoice to the subscription and price this storefront sold. */
export function invoiceMatchesOffer(
  invoice: Parameters<typeof invoiceSubscriptionId>[0] & Parameters<typeof invoicePriceIds>[0],
  subscriptionId: string,
  priceId: string
): boolean {
  return Boolean(subscriptionId) &&
    invoiceSubscriptionId(invoice) === subscriptionId &&
    invoicePriceIds(invoice).includes(priceId);
}

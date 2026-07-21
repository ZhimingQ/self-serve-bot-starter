import assert from "node:assert/strict";
import test from "node:test";
import {
  checkoutMatchesOffer,
  invoiceMatchesOffer,
  isFundedCheckoutSession,
  isFundedInvoice,
  isFundedStorefrontCheckout,
} from "./payment.ts";

test("only a positive paid Checkout session grants access", () => {
  assert.equal(isFundedCheckoutSession({ payment_status: "paid", amount_total: 2000 }), true);
  assert.equal(isFundedCheckoutSession({ payment_status: "paid", amount_total: 0 }), false);
  assert.equal(isFundedCheckoutSession({ payment_status: "no_payment_required", amount_total: 0 }), false);
  assert.equal(isFundedCheckoutSession({ payment_status: "unpaid", amount_total: 2000 }), false);
});

test("zero-value invoices never grant access", () => {
  assert.equal(isFundedInvoice({ amount_paid: 2000 }), true);
  assert.equal(isFundedInvoice({ amount_paid: 0 }), false);
  assert.equal(isFundedInvoice({ amount_paid: null }), false);
});

const checkout = {
  mode: "subscription",
  payment_status: "paid",
  amount_total: 2900,
  metadata: { storefrontPriceId: "price_storefront", storefrontBillingMode: "subscription" },
  line_items: { data: [{ price: { id: "price_storefront" } }] },
};

test("checkout must match the configured storefront price and mode", () => {
  assert.equal(checkoutMatchesOffer(checkout, "price_storefront", "subscription"), true);
  assert.equal(isFundedStorefrontCheckout(checkout, "price_storefront", "subscription"), true);
  assert.equal(checkoutMatchesOffer(checkout, "price_unrelated", "subscription"), false);
  assert.equal(checkoutMatchesOffer(checkout, "price_storefront", "payment"), false);
});

test("invoice must match the persisted subscription and configured price", () => {
  const invoice = {
    parent: { subscription_details: { subscription: "sub_storefront" } },
    lines: { data: [{ pricing: { price_details: { price: "price_storefront" } } }] },
  };
  assert.equal(invoiceMatchesOffer(invoice, "sub_storefront", "price_storefront"), true);
  assert.equal(invoiceMatchesOffer(invoice, "sub_other", "price_storefront"), false);
  assert.equal(invoiceMatchesOffer(invoice, "sub_storefront", "price_other"), false);
});

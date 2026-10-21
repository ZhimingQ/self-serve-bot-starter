/**
 * WORKSPACE_MODE — how much of the customer workspace this storefront shows.
 *
 *  full    (default) the whole control panel: overview, prompts, history, usage,
 *          notifications, billing, settings, security, account, privacy, help,
 *          plus Channels / Model key / Bot tools when those are enabled.
 *  simple  sign in and chat. The customer lands straight in the chat and sees
 *          only Chat, History, Account, Your data, Help, and Billing when payments
 *          are on. Channels, Model key and Bot tools are forced OFF — hidden in
 *          the UI and refused server-side — whatever their own switches say.
 *          Made for audiences that only need to talk to the assistant, such as
 *          students.
 *
 * Kept free of node: imports so the parser is testable on its own.
 */

export type WorkspaceMode = "full" | "simple";

/** Unset, empty or "full" is the full workspace. Anything else — including a
 *  typo such as "simpel" — is read as "simple": the restrictive reading is the
 *  safe one, because the reseller who set the switch clearly meant to hide
 *  something, and a misspelling must never re-expose the panels they hid. */
export function parseWorkspaceMode(raw: string | undefined): WorkspaceMode {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "full") return "full";
  return "simple";
}

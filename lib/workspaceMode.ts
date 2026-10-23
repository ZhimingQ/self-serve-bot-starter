/**
 * WORKSPACE_MODE — how much of the customer workspace this storefront shows.
 *
 *  full    (default) the whole control panel: overview, prompts, history, usage,
 *          notifications, billing, settings, security, account, privacy, help,
 *          plus Channels / Model key / Bot tools when those are enabled.
 *  simple  sign in and chat. The customer lands straight in the chat and sees
 *          only Chat, History, Account, Your data, Help, and Billing when payments
 *          are on. Channels, Model key and Bot tools start OFF (hidden in the UI
 *          and refused server-side); setting one's own switch explicitly
 *          (ALLOW_CHANNEL_CONNECT=1, BOT_TOOLS=..., ALLOW_END_USER_BYOK=1)
 *          still turns it on, and it then appears in the sidebar.
 *          Made for audiences that only need to talk to the assistant.
 *  students  everything simple mode restricts, plus a student website: a
 *          coursework landing page, a sign-up with an optional school year
 *          (creating the account confirms 13+, a guardian's agreement under
 *          18), a study-desk chat,
 *          and built-in tutor rules (explain, cite sources, never write the
 *          coursework). Made for GCSE and A-level coursework help.
 *
 * Kept free of node: imports so the parser is testable on its own.
 */

export type WorkspaceMode = "full" | "simple" | "students";

/** Unset, empty or "full" is the full workspace; "students" is the student
 *  website. Anything else — including a
 *  typo such as "simpel" — is read as "simple": the restrictive reading is the
 *  safe one, because the reseller who set the switch clearly meant to hide
 *  something, and a misspelling must never re-expose the panels they hid. */
export function parseWorkspaceMode(raw: string | undefined): WorkspaceMode {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "full") return "full";
  if (value === "students") return "students";
  return "simple";
}

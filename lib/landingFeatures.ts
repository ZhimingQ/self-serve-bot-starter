// What the landing page advertises: exactly the channels and tools a customer of
// THIS storefront can really use, and nothing else. Pure, so it is unit-tested
// without the env-reading config module (see landingFeatures.test.mjs).

import type { BotToolId } from "./botTools";

export type LandingChannel = "wechat" | "telegram" | "whatsapp" | "discord" | "feishu" | "slack";

// The platform decides what each framework can connect, and the Channels panel
// only learns it at runtime from GET /v1/instances/{id}/channels. The landing is
// rendered before any bot exists, so it mirrors that rule here: OpenClaw cannot
// connect Slack (OPENCLAW_CONNECT_PLATFORMS in the platform's
// src/lib/channels/channelOrchestration.ts), Hermes can connect all six.
const FRAMEWORK_UNSUPPORTED: Record<string, readonly string[]> = {
  openclaw: ["slack"],
  hermes: [],
};

// English visitors know Telegram and WhatsApp first; Chinese visitors know
// WeChat and Feishu first.
const ORDER: Record<"en" | "zh", readonly LandingChannel[]> = {
  en: ["telegram", "whatsapp", "discord", "slack", "wechat", "feishu"],
  zh: ["wechat", "feishu", "telegram", "whatsapp", "discord", "slack"],
};

export function landingChannels(input: {
  offered: readonly string[];
  framework: string;
  connectEnabled: boolean;
  locale: "en" | "zh";
}): LandingChannel[] {
  if (!input.connectEnabled) return [];
  // An unknown framework could connect anything or nothing; advertise nothing.
  const unsupported = FRAMEWORK_UNSUPPORTED[input.framework];
  if (!unsupported) return [];
  return ORDER[input.locale].filter((id) => input.offered.includes(id) && !unsupported.includes(id));
}

export type LandingTool =
  | { id: "desktop" | "files" | "computer" | "video" | "ssh" | "endpoint" | "power" | "byok" }
  | { id: "backup"; variant: "both" | "backup" | "restore" };

// Tools the platform serves for one framework only. Video is Hermes-only: the
// platform's /v1/instances/{id}/video route loads the bot with
// frameworks: ['hermes'], so an OpenClaw customer could never use it.
const TOOL_FRAMEWORKS: Partial<Record<BotToolId, readonly string[]>> = {
  video: ["hermes"],
};

/** One tile per enabled tool the framework can serve. Backup and restore share
 *  a tile, worded for whichever of the two this storefront actually turned on. */
export function landingTools(input: { tools: readonly BotToolId[]; byok: boolean; framework: string }): LandingTool[] {
  const on = (id: BotToolId) =>
    input.tools.includes(id) && (TOOL_FRAMEWORKS[id]?.includes(input.framework) ?? true);
  const out: LandingTool[] = [];
  for (const id of ["desktop", "files", "computer", "video", "ssh", "endpoint"] as const) {
    if (on(id)) out.push({ id });
  }
  if (on("backup") || on("import")) {
    out.push({ id: "backup", variant: on("backup") && on("import") ? "both" : on("backup") ? "backup" : "restore" });
  }
  if (on("power")) out.push({ id: "power" });
  if (input.byok) out.push({ id: "byok" });
  return out;
}

/** "Telegram, WhatsApp and Discord", or with `max`, "Telegram, WhatsApp and more". */
export function joinNames(
  names: readonly string[],
  words: { sep: string; and: string; more: string },
  max = Infinity,
): string {
  if (names.length === 0) return "";
  if (names.length > max) return `${names.slice(0, max).join(words.sep)}${words.more}`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(words.sep)}${words.and}${names[names.length - 1]}`;
}

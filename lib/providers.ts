/**
 * The funding providers a customer may point their own key at.
 *
 * Lives here rather than inside ModelKeyPanel so that the locale test can import
 * the REAL array instead of regex-parsing it out of a .tsx file. That parsing is
 * what this module replaces: a regex keyed on `id: "..."` silently returned a
 * SHORT list if any entry used single quotes or different spacing, so the
 * completeness check it fed could pass while a provider had no note — the exact
 * class of bug the check exists to catch (found in review, 2026-09-16).
 *
 * Adding a provider here means adding a `providerNote` entry to BOTH locale
 * blocks in i18n.ts. `Messages` is a union of the two locale objects, so
 * `copy.providerNote[option.id]` stops typechecking the moment one is missing —
 * which fails the standalone build, which makes the prebuilt storefront artifact
 * get skipped, which silently pushes every install onto the slow in-container
 * build. That went unnoticed for 13 days after 2026-09-03.
 */
export const PROVIDERS = [
  { id: "openrouter", label: "OpenRouter", keysUrl: "https://openrouter.ai/keys" },
  { id: "anthropic", label: "Anthropic", keysUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", keysUrl: "https://platform.openai.com/api-keys" },
  { id: "groq", label: "Groq", keysUrl: "https://console.groq.com/keys" },
  { id: "deepseek", label: "DeepSeek", keysUrl: "https://platform.deepseek.com/api_keys" },
  { id: "qwen", label: "Qwen", keysUrl: "https://bailian.console.aliyun.com/" },
  { id: "zai", label: "Z.AI", keysUrl: "https://z.ai/manage-apikey/apikey-list" },
  { id: "minimax", label: "MiniMax", keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key" },
  { id: "moonshot", label: "Moonshot", keysUrl: "https://platform.moonshot.ai/console/api-keys" },
  { id: "xai", label: "xAI", keysUrl: "https://console.x.ai" },
  { id: "google", label: "Google Gemini", keysUrl: "https://aistudio.google.com/apikey" },
  { id: "nousportal", label: "Nous Portal", keysUrl: "https://portal.nousresearch.com/" },
  { id: "opencode-go", label: "OpenCode Go", keysUrl: "https://opencode.ai/go" },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

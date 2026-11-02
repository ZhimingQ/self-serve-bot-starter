/**
 * Providers a Hermes customer can point their own key at. Client-safe (no
 * secrets): the panel renders this list and the server route resolves the
 * provider id to its base URL from the SAME list, so the browser never names a
 * URL for a listed provider.
 *
 * Every entry is an OpenAI-compatible endpoint, because Hermes takes a custom
 * key through its `custom` provider slot (base_url + api_key + model).
 */
export const HERMES_PROVIDERS = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keysUrl: "https://openrouter.ai/keys", logo: "openrouter" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", keysUrl: "https://platform.openai.com/api-keys", logo: "openai" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", keysUrl: "https://console.anthropic.com/settings/keys", logo: "claude-color" },
  { id: "google", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keysUrl: "https://aistudio.google.com/apikey", logo: "gemini-color" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keysUrl: "https://platform.deepseek.com/api_keys", logo: "deepseek-color" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keysUrl: "https://console.groq.com/keys", logo: "groq" },
  { id: "qwen", label: "Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keysUrl: "https://bailian.console.aliyun.com/", logo: "qwen-color" },
  { id: "zai", label: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4", keysUrl: "https://z.ai/manage-apikey/apikey-list", logo: "zhipu-color" },
  { id: "moonshot", label: "Moonshot", baseUrl: "https://api.moonshot.ai/v1", keysUrl: "https://platform.moonshot.ai/console/api-keys", logo: "moonshot" },
  { id: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.io/v1", keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key", logo: "minimax-color" },
  { id: "opencode-go", label: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", keysUrl: "https://opencode.ai/go", logo: "opencode" },
  { id: "opencode-zen", label: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1", keysUrl: "https://opencode.ai/auth", logo: "opencode" },
  { id: "xai", label: "xAI", baseUrl: "https://api.x.ai/v1", keysUrl: "https://console.x.ai/team/default/api-keys", logo: "xai" },
  { id: "nousportal", label: "Nous Portal", baseUrl: "https://inference-api.nousresearch.com/v1", keysUrl: "https://portal.nousresearch.com/", logo: "nousportal" },
  { id: "ollama-cloud", label: "Ollama Cloud", baseUrl: "https://ollama.com/v1", keysUrl: "https://ollama.com/settings/keys", logo: "ollama" },
  { id: "agnes", label: "Agnes", baseUrl: "https://apihub.agnes-ai.com/v1", keysUrl: "https://platform.agnes-ai.com/", logo: "agnes" },
] as const;

export type HermesProviderId = (typeof HERMES_PROVIDERS)[number]["id"] | "custom";

/** The platform's own rule for a model id (hermes-profile MODEL_RE). Checked
 *  here too so a bad id is refused before any request leaves the storefront. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9/._:-]{0,127}$/;

export function hermesProvider(id: string) {
  return HERMES_PROVIDERS.find((p) => p.id === id) ?? null;
}

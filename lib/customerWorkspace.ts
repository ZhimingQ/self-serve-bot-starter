export const MAX_HISTORY_MESSAGES = 200;
export const MAX_HISTORY_CONTENT_CHARS = 20_000;
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 1_000;
/** The reseller's own standing instructions for every customer's assistant
 *  (assistant-instructions.txt / ASSISTANT_INSTRUCTIONS). Larger than a
 *  customer's preferences because it describes the whole service. */
export const MAX_ASSISTANT_INSTRUCTIONS_CHARS = 2_000;

export type ResponseStyle = "balanced" | "concise" | "detailed";

export interface AssistantPreferences {
  responseStyle: ResponseStyle;
  customInstructions: string;
}

export interface StoredChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** Monotonic per-customer turn order. Optional for snapshots created before
   * the customer workspace added persistent history. */
  turnSequence?: number;
  error?: boolean;
}

export interface AssistantStreamCapture {
  pending: string;
  content: string;
  error: boolean;
}

export const defaultAssistantPreferences: AssistantPreferences = {
  responseStyle: "balanced",
  customInstructions: "",
};

export function limitStoredHistory(messages: StoredChatMessage[]): StoredChatMessage[] {
  return messages.slice(-MAX_HISTORY_MESSAGES);
}

export function orderStoredHistory(messages: StoredChatMessage[]): StoredChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const aSequence = a.message.turnSequence;
      const bSequence = b.message.turnSequence;
      if (aSequence === undefined && bSequence === undefined) return a.index - b.index;
      if (aSequence === undefined) return -1;
      if (bSequence === undefined) return 1;
      return aSequence - bSequence || a.index - b.index;
    })
    .map(({ message }) => message);
}

export function createAssistantStreamCapture(): AssistantStreamCapture {
  return { pending: "", content: "", error: false };
}

/** Collect assistant text from OpenAI-compatible SSE without buffering the
 * response sent to the customer. `final` flushes a last line without a newline. */
export function consumeAssistantSseText(
  capture: AssistantStreamCapture,
  text: string,
  final = false
): void {
  const lines = `${capture.pending}${text}`.split("\n");
  capture.pending = final ? "" : (lines.pop() ?? "");

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trimStart().startsWith("data:")) continue;
    const payload = line.trimStart().slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed?.error) capture.error = true;
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && capture.content.length < MAX_HISTORY_CONTENT_CHARS) {
        capture.content += delta.slice(0, MAX_HISTORY_CONTENT_CHARS - capture.content.length);
      }
    } catch {
      // Ignore malformed keep-alives; the customer stream continues unchanged.
    }
  }
}

export function normalizeAssistantPreferences(value: unknown): AssistantPreferences {
  if (!value || typeof value !== "object") return { ...defaultAssistantPreferences };
  const candidate = value as Partial<AssistantPreferences>;
  const responseStyle: ResponseStyle =
    candidate.responseStyle === "concise" || candidate.responseStyle === "detailed"
      ? candidate.responseStyle
      : "balanced";
  const customInstructions =
    typeof candidate.customInstructions === "string"
      ? candidate.customInstructions.trim().slice(0, MAX_CUSTOM_INSTRUCTIONS_CHARS)
      : "";
  return { responseStyle, customInstructions };
}

/** Trim and cap the reseller's standing instructions. Non-strings read as none. */
export function normalizeAssistantInstructions(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_ASSISTANT_INSTRUCTIONS_CHARS) : "";
}

/** Wrap the customer's message with the reseller's standing instructions (if
 *  any) and the customer's own response preferences (if not the defaults).
 *  The reseller's block comes first and is applied on every turn server-side,
 *  so it holds for the whole conversation and a customer cannot switch it off
 *  from the browser. With neither set, the input passes through unchanged. */
export function prepareAssistantInput(
  input: string,
  preferences: AssistantPreferences,
  assistantInstructions = ""
): string {
  const normalized = normalizeAssistantPreferences(preferences);
  const service = normalizeAssistantInstructions(assistantInstructions);
  const hasPreferences = !(normalized.responseStyle === "balanced" && !normalized.customInstructions);
  if (!service && !hasPreferences) return input;

  const blocks: string[] = [];
  if (service) {
    blocks.push(`[Service instructions from the provider of this assistant — always follow these: ${service}]`);
  }
  if (hasPreferences) {
    const style = {
      balanced: "Use a balanced amount of detail.",
      concise: "Keep the response concise and direct.",
      detailed: "Give a thorough response with useful detail.",
    }[normalized.responseStyle];
    const extra = normalized.customInstructions
      ? ` Follow these customer preferences when relevant: ${normalized.customInstructions}`
      : "";
    blocks.push(`[Customer response preferences: ${style}${extra}]`);
  }
  return `${blocks.join("\n")}\n\nCustomer request:\n${input}`;
}

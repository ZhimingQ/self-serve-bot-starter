export const MAX_HISTORY_MESSAGES = 200;
export const MAX_HISTORY_CONTENT_CHARS = 20_000;
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 1_000;

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

export function prepareAssistantInput(input: string, preferences: AssistantPreferences): string {
  const normalized = normalizeAssistantPreferences(preferences);
  if (normalized.responseStyle === "balanced" && !normalized.customInstructions) return input;

  const style = {
    balanced: "Use a balanced amount of detail.",
    concise: "Keep the response concise and direct.",
    detailed: "Give a thorough response with useful detail.",
  }[normalized.responseStyle];
  const extra = normalized.customInstructions
    ? ` Follow these customer preferences when relevant: ${normalized.customInstructions}`
    : "";
  return `[Customer response preferences: ${style}${extra}]\n\nCustomer request:\n${input}`;
}

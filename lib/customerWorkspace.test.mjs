import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeAssistantSseText,
  createAssistantStreamCapture,
  limitStoredHistory,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_HISTORY_CONTENT_CHARS,
  MAX_HISTORY_MESSAGES,
  normalizeAssistantPreferences,
  orderStoredHistory,
  prepareAssistantInput,
} from "./customerWorkspace.ts";

test("normalizes unknown preferences to safe defaults", () => {
  assert.deepEqual(normalizeAssistantPreferences(null), {
    responseStyle: "balanced",
    customInstructions: "",
  });
  assert.deepEqual(normalizeAssistantPreferences({ responseStyle: "unknown", customInstructions: 42 }), {
    responseStyle: "balanced",
    customInstructions: "",
  });
});

test("trims and caps custom instructions", () => {
  const preferences = normalizeAssistantPreferences({
    responseStyle: "concise",
    customInstructions: `  ${"x".repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS + 50)}  `,
  });
  assert.equal(preferences.responseStyle, "concise");
  assert.equal(preferences.customInstructions.length, MAX_CUSTOM_INSTRUCTIONS_CHARS);
});

test("leaves input unchanged when default preferences are selected", () => {
  assert.equal(
    prepareAssistantInput("Draft an update", { responseStyle: "balanced", customInstructions: "" }),
    "Draft an update"
  );
});

test("adds response preferences without changing the customer request", () => {
  const prepared = prepareAssistantInput("Draft an update", {
    responseStyle: "detailed",
    customInstructions: "Use plain language.",
  });
  assert.match(prepared, /thorough response/);
  assert.match(prepared, /Use plain language/);
  assert.match(prepared, /Customer request:\nDraft an update$/);
});

test("captures assistant SSE across chunk boundaries and marks upstream errors", () => {
  const capture = createAssistantStreamCapture();
  consumeAssistantSseText(capture, 'data: {"choices":[{"delta":{"content":"Hel');
  consumeAssistantSseText(capture, 'lo"}}]}\n\ndata: {"error":"interrupted"}\n');
  consumeAssistantSseText(capture, "data: [DONE]", true);
  assert.equal(capture.content, "Hello");
  assert.equal(capture.error, true);
});

test("caps captured assistant content and stored message count", () => {
  const capture = createAssistantStreamCapture();
  consumeAssistantSseText(
    capture,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(MAX_HISTORY_CONTENT_CHARS + 10) } }] })}\n`,
    true
  );
  assert.equal(capture.content.length, MAX_HISTORY_CONTENT_CHARS);

  const messages = Array.from({ length: MAX_HISTORY_MESSAGES + 4 }, (_, index) => ({
    id: String(index),
    role: "user",
    content: String(index),
    createdAt: "2026-07-19T00:00:00.000Z",
  }));
  const limited = limitStoredHistory(messages);
  assert.equal(limited.length, MAX_HISTORY_MESSAGES);
  assert.equal(limited[0].id, "4");
});

test("orders concurrent turns by request sequence while keeping prompt before reply", () => {
  const createdAt = "2026-07-19T00:00:00.000Z";
  const messages = [
    { id: "2u", role: "user", content: "second", createdAt, turnSequence: 2 },
    { id: "2a", role: "assistant", content: "second reply", createdAt, turnSequence: 2 },
    { id: "1u", role: "user", content: "first", createdAt, turnSequence: 1 },
    { id: "1a", role: "assistant", content: "first reply", createdAt, turnSequence: 1 },
  ];
  assert.deepEqual(orderStoredHistory(messages).map((message) => message.id), ["1u", "1a", "2u", "2a"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { botState, formatBytes, modelLabel, toBotView } from "./botInfo.ts";

test("platform statuses map onto the customer's states", () => {
  assert.equal(botState("running"), "running");
  assert.equal(botState("creating"), "starting");
  assert.equal(botState("stopped"), "stopped");
  assert.equal(botState("sleeping"), "sleeping");
  assert.equal(botState("error"), "error");
  assert.equal(botState("weird"), "unknown");
  assert.equal(botState(undefined), "unknown");
});

test("model label keeps the model's own name and drops platform/provider names", () => {
  assert.equal(modelLabel("opencode-go/minimax-m3.1-flash"), "minimax-m3.1-flash");
  assert.equal(modelLabel("anthropic/claude-sonnet-4.5"), "claude-sonnet-4.5");
  assert.equal(modelLabel("deepseek-v4"), "deepseek-v4");
  assert.equal(modelLabel("openrouter/openrouter-auto"), null);
  assert.equal(modelLabel("x/opencode-go"), null);
  assert.equal(modelLabel("x/ocl-proxy"), null);
  assert.equal(modelLabel("x/<script>"), null);
  assert.equal(modelLabel(""), null);
  assert.equal(modelLabel(null), null);
});

test("toBotView passes only the known fields, typed", () => {
  const v = toBotView({
    id: "c738", status: "running", framework: "hermes", assistant_name: "  Ada  ", size: "pro", cpu: 2, memory_bytes: 4294967296,
    disk_limit_bytes: 42949672960, disk_used_bytes: 1288490188, version: "2026.8.19",
    started_at: "2026-10-25T07:06:50Z", model: "opencode-go/minimax-m3.1-flash", created_at: "2026-10-25T06:46:37Z",
    server: "nuremberg", container_name: "hermes-warm-3000-11122",
  });
  assert.deepEqual(v, {
    state: "running", assistantName: "Ada", size: "pro", cpu: 2, memoryBytes: 4294967296, diskLimitBytes: 42949672960, diskUsedBytes: 1288490188,
    version: "2026.8.19", startedAt: "2026-10-25T07:06:50.000Z", model: "minimax-m3.1-flash", createdAt: "2026-10-25T06:46:37.000Z",
  });
  assert.ok(!JSON.stringify(v).includes("nuremberg"));
  assert.ok(!JSON.stringify(v).includes("hermes-warm"));
});

test("toBotView tolerates a missing or odd reply", () => {
  const v = toBotView(null);
  assert.equal(v.state, "unknown");
  assert.equal(v.size, null);
  assert.equal(v.assistantName, null);
  assert.equal(toBotView({ version: "ghcr.io/x:latest", cpu: -1, started_at: "nope" }).version, null);
  assert.equal(toBotView({ cpu: -1 }).cpu, null);
  assert.equal(toBotView({ started_at: "nope" }).startedAt, null);
});

test("formatBytes", () => {
  assert.equal(formatBytes(null), null);
  assert.equal(formatBytes(740 * 1024 ** 2), "740 MB");
  assert.equal(formatBytes(1.2 * 1024 ** 3), "1.2 GB");
  assert.equal(formatBytes(40 * 1024 ** 3), "40 GB");
  assert.equal(formatBytes(4 * 1024 ** 3), "4 GB");
  assert.equal(formatBytes(10), "1 MB");
});

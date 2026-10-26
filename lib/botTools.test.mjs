import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentDisposition,
  base64JsonStream,
  botToolsProblems,
  cleanFilePath,
  cleanFolderList,
  knownBotTools,
  looksLikeTailscaleAuthKey,
  multipartStream,
  normalizePairingCode,
  parseBotTools,
  parseCategoryList,
} from "./botTools.ts";

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return Buffer.concat(parts);
}

test("BOT_TOOLS: unset means every tool, none means none", () => {
  assert.deepEqual(parseBotTools(undefined), [...knownBotTools]);
  assert.deepEqual(parseBotTools("  "), [...knownBotTools]);
  assert.deepEqual(parseBotTools("none"), []);
  assert.deepEqual(parseBotTools("OFF"), []);
});

test("BOT_TOOLS: a list keeps display order and drops unknown names", () => {
  assert.deepEqual(parseBotTools("files, power ,Files"), ["power", "files"]);
  assert.deepEqual(parseBotTools("power,sshh"), ["power"]);
});

test("BOT_TOOLS: a list naming nothing known is NO tools, never all of them", () => {
  assert.deepEqual(parseBotTools("powr,fils"), []);
  assert.deepEqual(botToolsProblems("powr,files").length, 1);
  assert.deepEqual(botToolsProblems("power,files"), []);
  assert.deepEqual(botToolsProblems(undefined), []);
  assert.deepEqual(botToolsProblems("none"), []);
});

test("file paths stay inside the assistant's folder", () => {
  assert.equal(cleanFilePath("", { allowRoot: true }), "");
  assert.equal(cleanFilePath(undefined, { allowRoot: true }), "");
  assert.equal(cleanFilePath("", { allowRoot: false }), null);
  assert.equal(cleanFilePath("workspace//notes/./a.md/", { allowRoot: false }), "workspace/notes/a.md");
  assert.equal(cleanFilePath("/etc/passwd", { allowRoot: false }), null);
  assert.equal(cleanFilePath("a/../../etc", { allowRoot: false }), null);
  assert.equal(cleanFilePath("..", { allowRoot: true }), null);
  assert.equal(cleanFilePath("a\\b", { allowRoot: false }), null);
  assert.equal(cleanFilePath("a\nb", { allowRoot: false }), null);
  assert.equal(cleanFilePath(42, { allowRoot: true }), null);
  assert.equal(cleanFilePath("x".repeat(1025), { allowRoot: true }), null);
});

test("categories are all-or-nothing against the allowlist", () => {
  const allowed = ["config", "agents", "sessions"];
  assert.deepEqual(parseCategoryList("config,agents,config", allowed), ["config", "agents"]);
  assert.equal(parseCategoryList("config,credentials", allowed), null);
  assert.equal(parseCategoryList("", allowed), null);
  assert.equal(parseCategoryList(["config"], allowed), null);
});

test("only Tailscale AUTH keys are accepted", () => {
  assert.equal(looksLikeTailscaleAuthKey("tskey-auth-kAbCdEf1CNTRL-0123456789abcdef"), true);
  assert.equal(looksLikeTailscaleAuthKey("tskey-client-kAbCdEf1CNTRL-0123456789abcdef"), false);
  assert.equal(looksLikeTailscaleAuthKey("tskey-auth-short"), false);
  assert.equal(looksLikeTailscaleAuthKey("tskey-auth-abc def ghi jkl mno pqr"), false);
});

test("pairing codes are normalised, folders are bounded", () => {
  assert.equal(normalizePairingCode("abcd-1234"), "ABCD1234");
  assert.equal(normalizePairingCode("ab"), null);
  assert.equal(normalizePairingCode("abcd;1234"), null);
  assert.deepEqual(cleanFolderList([" ~/Documents ", "~/Documents", "D:\\Work"]), ["~/Documents", "D:\\Work"]);
  assert.equal(cleanFolderList([]), null);
  assert.equal(cleanFolderList(["a\u0000"]), null);
  assert.equal(cleanFolderList(new Array(11).fill("~/x")), null);
});

test("base64 JSON stream matches Buffer encoding across odd chunk boundaries", async () => {
  const bytes = Buffer.from(Array.from({ length: 1001 }, (_, i) => (i * 37) % 256));
  for (const sizes of [[1001], [1, 2, 998], [5, 7, 11, 978], [3, 3, 995]]) {
    let at = 0;
    const chunks = sizes.map((n) => {
      const c = new Uint8Array(bytes.subarray(at, at + n));
      at += n;
      return c;
    });
    const { stream, cap } = base64JsonStream(streamOf(chunks), { field: "content_base64", max: 5000 });
    const out = JSON.parse((await readAll(stream)).toString("utf8"));
    assert.equal(out.content_base64, bytes.toString("base64"));
    assert.equal(cap.bytes, 1001);
    assert.equal(cap.exceeded, false);
  }
  for (const len of [0, 1, 2, 3, 4]) {
    const b = Buffer.alloc(len, 0xab);
    const { stream } = base64JsonStream(streamOf(len ? [new Uint8Array(b)] : []), { field: "f", max: 10 });
    assert.equal(JSON.parse((await readAll(stream)).toString()).f, b.toString("base64"));
  }
});

test("base64 JSON stream stops at the cap", async () => {
  const { stream, cap } = base64JsonStream(streamOf([new Uint8Array(6), new Uint8Array(6)]), { field: "f", max: 10 });
  await assert.rejects(readAll(stream));
  assert.equal(cap.exceeded, true);
});

test("multipart stream is parseable and carries fields before the file", async () => {
  const payload = new Uint8Array([80, 75, 3, 4, 0, 1, 2, 255]);
  const boundary = "----bt" + "x".repeat(20);
  const { stream } = multipartStream(streamOf([payload.subarray(0, 3), payload.subarray(3)]), {
    boundary,
    fileField: "file",
    filename: "backup.zip",
    contentType: "application/zip",
    fields: { categories: "config,agents" },
    max: 100,
  });
  const body = await readAll(stream);
  const form = await new Response(body, { headers: { "content-type": `multipart/form-data; boundary=${boundary}` } }).formData();
  assert.equal(form.get("categories"), "config,agents");
  const file = form.get("file");
  assert.ok(file instanceof Blob);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), payload);
});

test("multipart stream stops at the cap", async () => {
  const { stream, cap } = multipartStream(streamOf([new Uint8Array(60), new Uint8Array(60)]), {
    boundary: "b",
    fileField: "file",
    filename: "x.zip",
    contentType: "application/zip",
    max: 100,
  });
  await assert.rejects(readAll(stream));
  assert.equal(cap.exceeded, true);
});

test("multipart stream reports its exact length and refuses a body of the wrong size", async () => {
  const opts = { boundary: "b", fileField: "file", filename: "x.zip", contentType: "application/zip", fields: { categories: "config" }, max: 100 };
  const exact = multipartStream(streamOf([new Uint8Array(10), new Uint8Array(5)]), { ...opts, expectedBytes: 15 });
  const body = await readAll(exact.stream);
  assert.equal(body.byteLength, exact.length);
  const long = multipartStream(streamOf([new Uint8Array(10), new Uint8Array(6)]), { ...opts, expectedBytes: 15 });
  await assert.rejects(readAll(long.stream));
  assert.equal(long.cap.exceeded, false);
  const short = multipartStream(streamOf([new Uint8Array(14)]), { ...opts, expectedBytes: 15 });
  await assert.rejects(readAll(short.stream));
  assert.equal(multipartStream(streamOf([]), opts).length, null);
});

test("download names cannot break the header", () => {
  const value = attachmentDisposition('notes "v2"\r\nX-Evil: 1.md');
  assert.ok(!/[\r\n]/.test(value));
  assert.match(value, /^attachment; filename="notes _v2___X-Evil: 1.md"; filename\*=UTF-8''/);
  assert.match(attachmentDisposition("报告.pdf"), /filename="__\.pdf"; filename\*=UTF-8''%E6%8A%A5/);
});

test("bot tools copy and UI never name the underlying platform", async () => {
  // The panel is white-label: a reseller's customer must not meet the
  // platform's or the frameworks' names in it. API-returned values (a base
  // URL, a connect command) are shown as given and are not in these sources.
  const { messages } = await import("./i18n.ts");
  const { readdirSync, readFileSync } = await import("node:fs");
  const brandWords = /openclaw|hermes/i;
  const walk = (node, path, out) => {
    for (const [k, v] of Object.entries(node)) {
      const p = `${path}.${k}`;
      if (typeof v === "function") out.push([p, String(v("x"))]);
      else if (v && typeof v === "object") walk(v, p, out);
      else out.push([p, String(v)]);
    }
    return out;
  };
  // One exception: the Hermes Desktop tool connects a third-party app whose
  // name IS "Hermes Desktop", so its own strings and section may say "Hermes".
  // They still may never name the platform.
  const platformWord = /openclaw/i;
  const isHermesDesktopCopy = (p) =>
    /\.botTools\.(hermesDesktop\.|tabs\.hermes-desktop$|errors\.hermes_desktop_unavailable$)/.test(p);
  for (const locale of ["en", "zh"]) {
    const hits = walk(messages[locale].botTools, `${locale}.botTools`, [])
      .filter(([p, v]) => (isHermesDesktopCopy(p) ? platformWord : brandWords).test(v));
    assert.deepEqual(hits, []);
  }
  const dir = new URL("../app/app/botTools/", import.meta.url);
  const files = [
    ...readdirSync(dir).map((f) => new URL(f, dir)),
    new URL("../app/app/BotToolsPanel.tsx", import.meta.url),
  ];
  for (const file of files) {
    // DesktopAppSection is the Hermes Desktop tool itself; elsewhere only its
    // tool id may appear (it is a config value, never shown to a customer).
    const words = file.pathname.endsWith("/DesktopAppSection.tsx") ? platformWord : brandWords;
    const source = readFileSync(file, "utf8").replaceAll('"hermes-desktop"', "");
    assert.ok(!words.test(source), `${file.pathname} names the platform`);
  }
});

test("every category the UI can show has a label in both locales", async () => {
  const { messages } = await import("./i18n.ts");
  const { backupCategories } = await import("./botTools.ts");
  for (const locale of ["en", "zh"]) {
    const labels = messages[locale].botTools.backup.categories;
    assert.deepEqual(backupCategories.filter((c) => typeof labels[c] !== "string"), []);
    assert.deepEqual(knownBotTools.filter((id) => typeof messages[locale].botTools.tabs[id] !== "string"), []);
  }
});

test("log lines: brand and providers scrubbed, shape checked, tail clamped", async () => {
  const { scrubLogText, toLogLines, parseLogTail } = await import("./botLogs.ts");
  assert.equal(
    scrubLogText("POST https://openclawlaunch.com/api/x failed; retrying OpenRouter via opencode-go, see OpenClaw Launch docs at api.openrouter.ai"),
    "POST [link] failed; retrying the AI provider via the AI provider, see the service docs at the AI provider",
  );
  assert.equal(scrubLogText("open the code editor and route it"), "open the code editor and route it");
  assert.equal(scrubLogText("OPENROUTER_API_KEY missing, OpenRouterError raised, OPENCLAWLAUNCH_URL unset"), "PROVIDER_API_KEY missing, providerError raised, SERVICE_URL unset");
  assert.equal(scrubLogText("see https://example.org/OpenClaw%20Launch?x=1 now"), "see [link] now");
  assert.equal(scrubLogText("fetch https://example.org/docs?q=1 ok"), "fetch https://example.org/docs?q=1 ok");
  assert.equal(scrubLogText("OpenCode got a 429; opencode-go down; OpenCode goes offline"), "the AI provider got a 429; the AI provider down; the AI provider goes offline");
  assert.equal(scrubLogText("OpenClaw    Launch connected; OpenClaw%20%20%20%20Launch too"), "the service connected; the service too");
  assert.equal(scrubLogText("GET /callback?provider=%6fpenrouter done"), "GET /callback?provider=the AI provider done");
  assert.equal(scrubLogText("see https://example.org/%6fpenrouter?text=%FF"), "see [link]");
  const t0 = Date.now();
  for (const unit of ["a.", "x".repeat(63) + ".", "openrouter", "%6f", "https://"]) scrubLogText(unit.repeat(Math.floor(2000 / unit.length)).repeat(1) + " end");
  const hostile = Array.from({ length: 500 }, () => ("a." + "x".repeat(63) + ".").repeat(30));
  for (const l of hostile) scrubLogText(l);
  assert.ok(Date.now() - t0 < 1500, `scrub took ${Date.now() - t0}ms`);
  const lines = toLogLines([
    { time: "2026-10-24T09:00:01Z", stream: "stderr", text: "openrouter 429" },
    { time: "<script>", stream: "weird", text: "x".repeat(3000) },
    { text: "   " },
    null,
    "junk",
  ]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { time: "2026-10-24T09:00:01Z", stream: "stderr", text: "the AI provider 429" });
  assert.equal(lines[1].time, null);
  assert.equal(lines[1].stream, "stdout");
  assert.equal(lines[1].text.length, 2001);
  assert.deepEqual(toLogLines("nope"), []);
  assert.equal(parseLogTail("500"), 500);
  assert.equal(parseLogTail("9999"), 200);
  assert.equal(parseLogTail(null), 200);
});

test("Hermes-only tools never reach an OpenClaw storefront", async () => {
  const { toolFitsFramework } = await import("./botTools.ts");
  for (const id of ["hermes-desktop", "plugins"]) {
    assert.equal(toolFitsFramework(id, "openclaw"), false);
    assert.equal(toolFitsFramework(id, "hermes"), true);
  }
  assert.equal(toolFitsFramework("power", "openclaw"), true);
});

test("plugins: catalog, job and form values are shape-checked", async () => {
  const { toPluginCatalog, toPluginJob, cleanPluginEnv, isPluginName, toInstalledPlugins } = await import("./botPlugins.ts");
  const cards = toPluginCatalog([
    { name: "memory-wiki", title: "Memory\nwiki", description: "x".repeat(600), category: "memory", tier: "official", env_fields: ["WIKI_TOKEN", "bad key"], installable: true, docs_url: "https://example.org/docs" },
    { name: "old-one", installable: false, reason: "needs_update", docs_url: "javascript:alert(1)" },
    { name: "risky", installable: false, reason: "made_up" },
    { name: "../etc", installable: true },
    "nope",
  ], (s) => s.replace(/Memory/g, "Notes"));
  assert.deepEqual(cards.map((c) => c.name), ["memory-wiki", "old-one", "risky"]);
  assert.equal(cards[0].title, "Notes wiki");
  assert.ok(cards[0].description.length <= 400);
  assert.deepEqual(cards[0].envFields, ["WIKI_TOKEN"]);
  assert.equal(cards[0].official, true);
  assert.equal(cards[1].reason, "needs_update");
  assert.equal(cards[1].docsUrl, null);
  // An unknown reason is treated as "not offered", never as installable.
  assert.equal(cards[2].installable, false);
  assert.equal(cards[2].reason, "not_offered");

  assert.deepEqual(toInstalledPlugins([{ name: "memory-wiki", enabled: false }, { name: "bad name" }]), [{ name: "memory-wiki", enabled: false }]);

  const job = toPluginJob({ id: "j1", action: "install", plugin: "memory-wiki", phase: "failed", error: "/opt/data trace", restart_slow: false });
  assert.deepEqual(job, { id: "j1", action: "install", plugin: "memory-wiki", phase: "failed", restartSlow: false });
  assert.equal(toPluginJob({ id: "j1", action: "wipe", plugin: "x", phase: "done" }), null);

  assert.deepEqual(cleanPluginEnv(undefined), {});
  assert.deepEqual(cleanPluginEnv({ WIKI_TOKEN: " abc ", EMPTY_ONE: "" }), { WIKI_TOKEN: "abc" });
  for (const bad of [{ WIKI_TOKEN: "has space" }, { WIKI_TOKEN: "a$b" }, { WIKI_TOKEN: "a'b" }, { lower: "x" }, { WIKI_TOKEN: 1 }, ["x"]]) {
    assert.equal(cleanPluginEnv(bad), null);
  }
  const branded = toPluginCatalog([{ name: "hermes-memory-wiki", description: "A Hermes Agent plugin for OpenClaw-style memory, by Nous Research.", installable: true }]);
  assert.equal(branded[0].name, "hermes-memory-wiki");
  assert.ok(!/hermes|openclaw|nous/i.test(`${branded[0].title} ${branded[0].description}`), `${branded[0].title} | ${branded[0].description}`);
  for (const docs of ["https://openclawlaunch.com/docs", "https://github.com/x/hermes-tool", "https://example.org/%4F%70%65%6E%43%6C%61%77"]) {
    assert.equal(toPluginCatalog([{ name: "p1", installable: true, docs_url: docs }])[0].docsUrl, null, docs);
  }
  const { withInstalledCards } = await import("./botPlugins.ts");
  const merged = withInstalledCards(cards, [{ name: "memory-wiki", enabled: true }, { name: "hermes-gone", enabled: true }]);
  assert.equal(merged.length, cards.length + 1);
  assert.deepEqual(
    { name: merged.at(-1).name, installable: merged.at(-1).installable, reason: merged.at(-1).reason },
    { name: "hermes-gone", installable: false, reason: "not_offered" },
  );
  assert.ok(!/hermes/i.test(merged.at(-1).title));
  assert.equal(isPluginName("a..b"), false);
  assert.equal(isPluginName("memory-wiki"), true);
});

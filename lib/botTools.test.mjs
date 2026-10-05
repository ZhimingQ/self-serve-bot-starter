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
  for (const locale of ["en", "zh"]) {
    const hits = walk(messages[locale].botTools, `${locale}.botTools`, []).filter(([, v]) => brandWords.test(v));
    assert.deepEqual(hits, []);
  }
  const dir = new URL("../app/app/botTools/", import.meta.url);
  const files = [
    ...readdirSync(dir).map((f) => new URL(f, dir)),
    new URL("../app/app/BotToolsPanel.tsx", import.meta.url),
  ];
  for (const file of files) {
    assert.ok(!brandWords.test(readFileSync(file, "utf8")), `${file.pathname} names the platform`);
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

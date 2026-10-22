import assert from "node:assert/strict";
import test from "node:test";
import { parseInline, parseMarkdown } from "./chatMarkdown.ts";

// The reply a real coursework storefront got on 2026-10-22, which the chat
// printed with its asterisks, hashes and pipes.
const REPLY = `I can't write the essay for you. But I can help you **research and understand** the causes of WW1.

---

## Key Causes of WW1 (M-A-I-N)

A useful framework is **M.A.I.N.**:

| Letter | Cause | Explanation |
|--------|-------|-------------|
| **M** | **Militarism** | Arms race between Germany, Britain, France. |
| **A** | **Alliances** | Triple Entente vs Triple Alliance. |

1. Read the BBC Bitesize page
2. Make notes

- Imperial War Museum: https://www.iwm.org.uk
- *Nationalism* mattered too`;

test("a real reply becomes headings, a rule, a table and lists, with no markers left", () => {
  const blocks = parseMarkdown(REPLY);
  assert.deepEqual(blocks.map((b) => b.t), ["p", "hr", "h", "p", "table", "ol", "ul"]);
  const h = blocks[2];
  assert.equal(h.level, 2);
  assert.deepEqual(h.c, [{ t: "text", v: "Key Causes of WW1 (M-A-I-N)" }]);
  const table = blocks[4];
  assert.equal(table.head.length, 3);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0][1], [{ t: "strong", c: [{ t: "text", v: "Militarism" }] }]);
  assert.equal(blocks[5].items.length, 2);
  assert.equal(blocks[5].start, 1);
  const json = JSON.stringify(blocks);
  assert.ok(!json.includes("**"), "no bold markers survive");
  assert.ok(!json.includes("##"), "no heading markers survive");
});

test("bold, italic, code and links inside a sentence", () => {
  assert.deepEqual(parseInline("a **b** *c* `d` [e](https://x.test/f)"), [
    { t: "text", v: "a " },
    { t: "strong", c: [{ t: "text", v: "b" }] },
    { t: "text", v: " " },
    { t: "em", c: [{ t: "text", v: "c" }] },
    { t: "text", v: " " },
    { t: "code", v: "d" },
    { t: "text", v: " " },
    { t: "link", href: "https://x.test/f", c: [{ t: "text", v: "e" }] },
  ]);
});

test("only http(s) and mailto links are kept; anything else is just its text", () => {
  assert.deepEqual(parseInline("[click](javascript:alert(1))"), [{ t: "text", v: "click" }]);
  assert.deepEqual(parseInline("[x](data:text/html,hi)"), [{ t: "text", v: "x" }]);
  assert.deepEqual(parseInline("[mail](mailto:a@b.test)"), [{ t: "link", href: "mailto:a@b.test", c: [{ t: "text", v: "mail" }] }]);
});

test("HTML in a reply stays text", () => {
  const blocks = parseMarkdown('<img src=x onerror="alert(1)"> <script>bad()</script>');
  assert.deepEqual(blocks, [{ t: "p", c: [{ t: "text", v: '<img src=x onerror="alert(1)"> <script>bad()</script>' }] }]);
});

test("a reply still streaming in reads sensibly", () => {
  assert.deepEqual(parseInline("so **half"), [{ t: "text", v: "so **half" }]);
  const open = parseMarkdown("Try:\n```js\nconst a = 1");
  assert.deepEqual(open, [{ t: "p", c: [{ t: "text", v: "Try:" }] }, { t: "code", v: "const a = 1" }]);
});

test("snake_case and maths are not turned into italics", () => {
  assert.deepEqual(parseInline("use my_var_name here"), [{ t: "text", v: "use my_var_name here" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ t: "text", v: "2 * 3 * 4" }]);
});

test("line breaks inside a paragraph are kept", () => {
  assert.deepEqual(parseMarkdown("one\ntwo"), [{ t: "p", c: [{ t: "text", v: "one" }, { t: "br" }, { t: "text", v: "two" }] }]);
});

test("a bare link ends before trailing punctuation", () => {
  assert.deepEqual(parseInline("see https://a.test/x."), [
    { t: "text", v: "see " },
    { t: "link", href: "https://a.test/x", c: [{ t: "text", v: "https://a.test/x" }] },
    { t: "text", v: "." },
  ]);
});

test("a quote and an indented continuation line", () => {
  assert.deepEqual(parseMarkdown("> quoted\n> more").map((b) => b.t), ["quote"]);
  const list = parseMarkdown("- first\n  still first\n- second")[0];
  assert.equal(list.items.length, 2);
});

test("a long reply with stray markers parses quickly", () => {
  const long = ("word * other ** [ x _ y ` ").repeat(4000) + "https://a.test/" + "x".repeat(5000);
  const t0 = Date.now();
  parseMarkdown(long);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
});

test("links with parentheses in the address, and with a title", () => {
  assert.deepEqual(parseInline("[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))."), [
    { t: "link", href: "https://en.wikipedia.org/wiki/Mercury_(planet)", c: [{ t: "text", v: "Mercury" }] },
    { t: "text", v: "." },
  ]);
  assert.deepEqual(parseInline('[a](https://a.test "Title")'), [{ t: "link", href: "https://a.test", c: [{ t: "text", v: "a" }] }]);
});

test("heading hashes: closing ones go, a literal one stays", () => {
  assert.deepEqual(parseMarkdown("## C#")[0].c, [{ t: "text", v: "C#" }]);
  assert.deepEqual(parseMarkdown("## Title ##")[0].c, [{ t: "text", v: "Title" }]);
  assert.deepEqual(parseMarkdown("# #")[0].c, []);
});

test("no block pattern backtracks badly on long runs of spaces or markers", () => {
  const pad = " ".repeat(60000);
  const inputs = [
    "# a" + pad + "x", "---" + pad + "x", "- " + pad + "x", "1." + pad + "x", ">" + pad + "x",
    "| a |\n|--" + pad + "x", "|" + "-- |".repeat(2000) + "x", "a|b\n" + "|--".repeat(2000) + "x",
    "# " + pad + "x\u2028x", "- " + pad + "x\u2028x", "1. " + pad + "x\u2028x", "> " + pad + "x\u2028x",
    "*".repeat(5000), "_".repeat(5000), "[".repeat(3000) + "](" + "(".repeat(3000), "**a" + pad,
  ];
  for (const input of inputs) {
    const t0 = Date.now();
    parseMarkdown(input);
    assert.ok(Date.now() - t0 < 500, `${JSON.stringify(input.slice(0, 12))} took ${Date.now() - t0}ms`);
  }
});

test("a list indented as a whole still parses, and nothing loops", () => {
  const b = parseMarkdown("  - one\n  - two\n    more of two\n\n   1. first\n   2. second");
  assert.deepEqual(b.map((x) => x.t), ["ul", "ol"]);
  assert.equal(b[0].items.length, 2);
  assert.equal(b[1].items.length, 2);
  for (const odd of ["  - item", "  1. item", "      - deep", "-", "1.", "- ", "  >", "#", "| |\n|--|"]) {
    const t0 = Date.now();
    parseMarkdown(odd);
    assert.ok(Date.now() - t0 < 200, JSON.stringify(odd));
  }
});

test("random Markdown-ish input always finishes quickly", () => {
  const alphabet = ["-", "*", "_", "#", ">", "|", "`", "~", "[", "]", "(", ")", "1", ".", " ", "  ", "\t", "\n", "\n\n", "a", "http://x.y/", "\\", " ", ":"];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let n = 0; n < 2000; n++) {
    let s = "";
    const len = 1 + Math.floor(rand() * 60);
    for (let k = 0; k < len; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
    const t0 = Date.now();
    parseMarkdown(s);
    assert.ok(Date.now() - t0 < 100, JSON.stringify(s));
  }
});

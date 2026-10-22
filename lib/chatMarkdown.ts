// Markdown in assistant replies, parsed into plain data for ChatMarkdown.tsx.
//
// Models answer in Markdown (headings, **bold**, tables), and the chat used to
// print it verbatim, so customers saw the asterisks and pipes (operator test,
// 2026-10-22). This is a deliberately small parser: no HTML is ever produced or
// passed through, the renderer builds React elements from these nodes, and a
// link is only kept for http(s) and mailto. Replies stream in, so anything left
// unclosed mid-stream (a lone ** or an open code fence) simply reads as text or
// as code until the rest arrives.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" }

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][]; start?: number }
  | { t: "quote"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }

// Block lines are classified with plain character checks, not regexes: a
// model can emit a line of tens of thousands of spaces, and every whitespace
// regex here would backtrack over it on each streamed update.
const isBlank = (c: string | undefined) => c === " " || c === "\t"
const indentOf = (line: string) => {
  let n = 0
  while (isBlank(line[n])) n++
  return n
}
const DASH_CELL = /^:?-{2,}:?$/

function fenceOf(line: string): string | null {
  const t = line.slice(indentOf(line), indentOf(line) + 3)
  return t === "```" || t === "~~~" ? t : null
}

function headingOf(line: string): { level: number; text: string } | null {
  let i = indentOf(line)
  if (i > 3) return null
  let level = 0
  while (line[i] === "#" && level < 7) { level++; i++ }
  if (level < 1 || level > 6 || !isBlank(line[i])) return null
  return { level, text: line.slice(i) }
}

function isRule(line: string): boolean {
  if (indentOf(line) > 3) return false
  const t = line.replace(/[ \t]/g, "")
  return t.length >= 3 && (/^-+$/.test(t) || /^\*+$/.test(t) || /^_+$/.test(t))
}

function bulletOf(line: string): string | null {
  const i = indentOf(line)
  const c = line[i]
  return (c === "-" || c === "*" || c === "+") && isBlank(line[i + 1]) ? line.slice(i + 2).trimStart() : null
}

function orderedOf(line: string): { n: number; text: string } | null {
  const i = indentOf(line)
  let j = i
  while (j < line.length && j - i < 10 && line[j] >= "0" && line[j] <= "9") j++
  if (j === i || j - i > 9 || (line[j] !== "." && line[j] !== ")") || !isBlank(line[j + 1])) return null
  return { n: Number(line.slice(i, j)), text: line.slice(j + 2).trimStart() }
}

function quoteOf(line: string): string | null {
  const i = indentOf(line)
  if (i > 3 || line[i] !== ">") return null
  return line.slice(isBlank(line[i + 1]) ? i + 2 : i + 1)
}

function isTableRule(line: string): boolean {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => DASH_CELL.test(c))
}

function safeHref(raw: string): string | null {
  const href = raw.trim()
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"))
}

// Sticky (`y`) patterns tried only where a marker character sits, so a long
// reply is not re-sliced or re-scanned at every character while it streams. A
// span is capped in length: an unclosed ** costs at most that far, not the rest
// of the reply.
const STRONG = /(\*\*|__)(?=\S)([^]{0,2000}?\S)\1/y
const EM = /(\*|_)(?=[^\s*_])([^\n]{0,500}?[^\s*_])\1(?![*_])/y
const LINK_TEXT = /\[([^\]\n]{1,500})\]\(/y
const BARE = /https?:\/\/[^\s<>()]{0,2000}[^\s<>().,;:!?'"]/y

/** `## Title ##` -> `Title`; `## C#` keeps its hash (no space before it). */
function headingText(raw: string): string {
  let t = raw.trimEnd()
  let j = t.length
  while (j > 0 && t[j - 1] === "#") j--
  if (j < t.length && (j === 0 || t[j - 1] === " " || t[j - 1] === "\t")) t = t.slice(0, j)
  return t.trim()
}

/** The `(destination)` after `[text]`, allowing balanced parentheses inside it
 *  (Wikipedia-style `Mercury_(planet)`) and an optional "title". Returns the
 *  href and the index just past the closing `)`, or null. */
function linkDestination(src: string, start: number): { href: string; end: number } | null {
  let depth = 0
  let j = start
  const limit = Math.min(src.length, start + 2000)
  while (j < limit) {
    const c = src[j]
    if (c === "(") depth++
    else if (c === ")") {
      if (depth === 0) break
      depth--
    } else if (c === " " || c === "\t" || c === "\n") break
    j++
  }
  if (j === start || j >= limit) return null
  const href = src.slice(start, j)
  if (src[j] === ")") return { href, end: j + 1 }
  const title = /[ \t]+"[^"\n]{0,200}"\)/y
  title.lastIndex = j
  const m = title.exec(src)
  return m ? { href, end: j + m[0].length } : null
}

function matchAt(re: RegExp, src: string, i: number): RegExpExecArray | null {
  re.lastIndex = i
  return re.exec(src)
}

/** Inline Markdown: `code`, **bold**, *em*, [text](url), bare links, line breaks. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let text = ""
  const flush = () => {
    if (text) out.push({ t: "text", v: text })
    text = ""
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === "\n") {
      flush()
      out.push({ t: "br" })
      i += 1
      continue
    }
    if (ch === "\\" && i + 1 < src.length && /[\\`*_[\]()#|>~-]/.test(src[i + 1])) {
      text += src[i + 1]
      i += 2
      continue
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1)
      if (end > i + 1) {
        flush()
        out.push({ t: "code", v: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    const marker = ch === "*" || ch === "_"
    const strong = marker ? matchAt(STRONG, src, i) : null
    if (strong && !(strong[1] === "__" && /\w/.test(src[i - 1] ?? ""))) {
      flush()
      out.push({ t: "strong", c: parseInline(strong[2]) })
      i += strong[0].length
      continue
    }
    const em = marker ? matchAt(EM, src, i) : null
    if (em && !(em[1] === "_" && (/\w/.test(src[i - 1] ?? "") || /\w/.test(src[i + em[0].length] ?? "")))) {
      flush()
      out.push({ t: "em", c: parseInline(em[2]) })
      i += em[0].length
      continue
    }
    const linkText = ch === "[" ? matchAt(LINK_TEXT, src, i) : null
    const dest = linkText ? linkDestination(src, i + linkText[0].length) : null
    if (linkText && dest) {
      const href = safeHref(dest.href)
      flush()
      if (href) out.push({ t: "link", href, c: parseInline(linkText[1]) })
      else out.push(...parseInline(linkText[1]))
      i = dest.end
      continue
    }
    const bare = ch === "h" ? matchAt(BARE, src, i) : null
    if (bare && !/\w/.test(src[i - 1] ?? "")) {
      flush()
      out.push({ t: "link", href: bare[0], c: [{ t: "text", v: bare[0] }] })
      i += bare[0].length
      continue
    }
    text += ch
    i += 1
  }
  flush()
  return out
}

/** Block Markdown: paragraphs, headings, lists, quotes, code, rules, tables. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let para: string[] = []
  const endPara = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join("\n")) })
    para = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const fence = fenceOf(line)
    if (fence) {
      endPara()
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++])
      i += 1 // the closing fence, or past the end while it is still streaming
      blocks.push({ t: "code", v: body.join("\n") })
      continue
    }
    if (!line.trim()) {
      endPara()
      i += 1
      continue
    }
    const heading = headingOf(line)
    if (heading) {
      endPara()
      blocks.push({ t: "h", level: heading.level, c: parseInline(headingText(heading.text)) })
      i += 1
      continue
    }
    if (isRule(line)) {
      endPara()
      blocks.push({ t: "hr" })
      i += 1
      continue
    }
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && isTableRule(lines[i + 1])) {
      endPara()
      const head = splitRow(line).map(parseInline)
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map(parseInline))
        i += 1
      }
      blocks.push({ t: "table", head, rows })
      continue
    }
    if (bulletOf(line) !== null || orderedOf(line)) {
      endPara()
      const ordered = bulletOf(line) === null
      const start = ordered ? orderedOf(line)!.n : undefined
      // Items sit at the first item's own indent (models often indent a whole
      // list); a line indented further continues the item above. The first
      // line always becomes an item, so this loop always moves forward.
      const base = indentOf(line)
      const items: string[] = []
      while (i < lines.length) {
        const cur = lines[i]
        const own = ordered ? orderedOf(cur)?.text ?? null : bulletOf(cur)
        if (own !== null && (items.length === 0 || indentOf(cur) < base + 2)) {
          items.push(own)
        } else if (cur.trim() && indentOf(cur) >= base + 2 && items.length) {
          // An indented line continues the item above (or is a nested item,
          // which is shown inline rather than as a second level).
          const nested = bulletOf(cur) ?? orderedOf(cur)?.text ?? null
          items[items.length - 1] += "\n" + (nested ?? cur.trim())
        } else break
        i += 1
      }
      blocks.push(ordered ? { t: "ol", items: items.map(parseInline), start } : { t: "ul", items: items.map(parseInline) })
      continue
    }
    if (quoteOf(line) !== null) {
      endPara()
      const body: string[] = []
      while (i < lines.length && quoteOf(lines[i]) !== null) body.push(quoteOf(lines[i++])!)
      blocks.push({ t: "quote", c: parseInline(body.join("\n")) })
      continue
    }
    para.push(line)
    i += 1
  }
  endPara()
  return blocks
}

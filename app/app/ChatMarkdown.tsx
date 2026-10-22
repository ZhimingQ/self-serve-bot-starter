// Renders an assistant reply's Markdown (lib/chatMarkdown.ts) as React elements.
// Never sets HTML: every node becomes an element or a text child, so a reply
// cannot inject markup, and links open in a new tab without a referrer.

import { Fragment, type ReactNode } from "react"
import { parseMarkdown, type Block, type Inline } from "../../lib/chatMarkdown"

function inline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text": return <Fragment key={i}>{n.v}</Fragment>
      case "code": return <code key={i}>{n.v}</code>
      case "strong": return <strong key={i}>{inline(n.c)}</strong>
      case "em": return <em key={i}>{inline(n.c)}</em>
      case "link": return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">{inline(n.c)}</a>
      case "br": return <br key={i} />
    }
  })
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case "p": return <p key={i}>{inline(b.c)}</p>
    case "h": {
      // Kept small: a chat bubble is not a document, so even # is a modest title.
      const Tag = b.level <= 2 ? "h3" : "h4"
      return <Tag key={i}>{inline(b.c)}</Tag>
    }
    case "ul": return <ul key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>
    case "ol": return <ol key={i} start={b.start}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>
    case "quote": return <blockquote key={i}>{inline(b.c)}</blockquote>
    case "code": return <pre key={i}><code>{b.v}</code></pre>
    case "hr": return <hr key={i} />
    case "table":
      return (
        <div key={i} className="md-table">
          <table>
            <thead><tr>{b.head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
  }
}

export default function ChatMarkdown({ text }: { text: string }) {
  return <>{parseMarkdown(text).map(block)}</>
}

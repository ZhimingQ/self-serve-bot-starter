"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Messages } from "../../lib/i18n";

export type ProviderOption<T extends string> = { id: T; label: string; note: string };

export const providerPickerText = (copy: Messages) => ({
  search: copy.providerSearch,
  recommended: copy.providerGroupRecommended,
  others: copy.providerGroupOthers,
  noMatch: copy.providerNoMatch,
});

/**
 * The provider field on both "use your own key" panels: one control that opens
 * a searchable list, so the form stays the same size however many providers the
 * list grows to. It only reports a choice; the panels own everything after it.
 */
export default function ProviderPicker<T extends string>({
  id, label, options, value, onChange, recommended, pinned, text,
}: {
  id: string;
  label: string;
  options: ProviderOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Listed first under its own heading. */
  recommended: T;
  /** Stays below the list whatever the search says: the way out when nothing matches. */
  pinned?: ProviderOption<T>;
  text: { search: string; recommended: string; others: string; noMatch: (query: string) => string };
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const uid = useId();

  const everything = pinned ? [...options, pinned] : options;
  const selected = everything.find((o) => o.id === value) ?? everything[0];
  const needle = query.trim().toLowerCase();
  const hits = options.filter((o) => `${o.label} ${o.note}`.toLowerCase().includes(needle));
  const top = needle ? [] : hits.filter((o) => o.id === recommended);
  const rest = needle ? hits : hits.filter((o) => o.id !== recommended);
  // Arrow keys walk the rows in the order they are drawn.
  const rows = pinned ? [...top, ...rest, pinned] : [...top, ...rest];
  const optionId = (o: ProviderOption<T>) => `${uid}-${o.id}`;

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (!open || active < 0 || !rows[active]) return;
    document.getElementById(optionId(rows[active]))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows is rebuilt every render.
  }, [open, active]);

  function show() {
    setQuery("");
    setActive(-1);
    setOpen(true);
  }

  function hide(refocus: boolean) {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }

  function choose(next: T) {
    onChange(next);
    hide(true);
  }

  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((n) => Math.min(n + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((n) => Math.max(n - 1, 0));
    } else if (event.key === "Enter") {
      // Inside the save form: Enter here picks a row, it must not submit the key.
      event.preventDefault();
      const row = rows[Math.max(active, 0)];
      if (row) choose(row.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      hide(true);
    } else if (event.key === "Tab") {
      hide(false);
    }
  }

  const row = (o: ProviderOption<T>) => (
    <button
      key={o.id}
      id={optionId(o)}
      type="button"
      role="option"
      aria-selected={o.id === value}
      className={`provider-row${o.id === value ? " is-selected" : ""}${rows[active]?.id === o.id ? " is-active" : ""}`}
      onClick={() => choose(o.id)}
    >
      <ProviderTile option={o} />
      <span className="provider-text"><strong>{o.label}</strong><small>{o.note}</small></span>
      {o.id === value && <span className="provider-check" aria-hidden="true">✓</span>}
    </button>
  );

  return (
    <div className="byok-field provider-picker" ref={root}>
      <label htmlFor={id}>{label}</label>
      <button
        id={id}
        ref={trigger}
        type="button"
        className="provider-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? hide(false) : show())}
      >
        <ProviderTile option={selected} />
        <span className="provider-text"><strong>{selected.label}</strong><small>{selected.note}</small></span>
        <svg className="provider-chevron" viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
          <path d="M5 7.5l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="provider-popup">
          <div className="provider-search">
            <input
              ref={search}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${uid}-list`}
              aria-activedescendant={rows[active] ? optionId(rows[active]) : undefined}
              aria-label={text.search}
              placeholder={text.search}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(-1); }}
              onKeyDown={onSearchKey}
            />
          </div>
          <div id={`${uid}-list`} role="listbox" aria-label={label} className="provider-list">
            {hits.length === 0 && <p className="provider-empty">{text.noMatch(query.trim())}</p>}
            {top.length > 0 && <div className="provider-group">{text.recommended}</div>}
            {top.map(row)}
            {!needle && rest.length > 0 && <div className="provider-group">{text.others}</div>}
            {rest.map(row)}
            {pinned && <div className="provider-pinned">{row(pinned)}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderTile({ option }: { option: { label: string } }) {
  return <span className="provider-tile" aria-hidden="true">{option.label.charAt(0)}</span>;
}

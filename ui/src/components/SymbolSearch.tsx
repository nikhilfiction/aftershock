/**
 * Type part of a name, pick a symbol. A combobox following the WAI-ARIA
 * pattern: arrow keys move, Enter picks, Escape closes.
 */
import { useEffect, useId, useState } from "react";

import { useSymbols } from "../api/hooks";
import type { SymbolHit } from "../api/types";
import { shortName } from "../lib/format";

type Props = {
  snapshotId: number;
  value: string;
  onChange: (qualifiedName: string) => void;
  error?: string;
};

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function SymbolSearch({ snapshotId, value, onChange, error }: Props) {
  const id = useId();
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const query = useDebounced(text, 250);
  const { data, isFetching, isError } = useSymbols(snapshotId, query, open && text !== value);
  const hits: SymbolHit[] = data ?? [];

  // when the parent sets a value (e.g. clicking a point on the radar), show it in the box
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(value);
  }

  function pick(hit: SymbolHit) {
    setLastValue(hit.name); // we made this change ourselves; don't sync it back
    setText(hit.name);
    setOpen(false);
    onChange(hit.name);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && hits[active]) {
      e.preventDefault();
      pick(hits[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const listId = `${id}-list`;
  const showList = open && text.trim().length > 0 && text !== value;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className="combo">
      <div className={`bar-field combo-field${error ? " invalid" : ""}`}>
        <label htmlFor={id}>
          <span className="prefix" aria-hidden="true">
            target:
          </span>
          <span className="field-name">Function, class or route</span>
        </label>
        <input
          id={id}
          className="bare-input mono"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && hits[active] ? `${listId}-${active}` : undefined}
          aria-invalid={Boolean(error)}
          aria-describedby={errorId ?? `${id}-hint`}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. decode_token"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setOpen(true);
            if (value) {
              setLastValue(""); // editing drops the picked symbol, but keeps what was typed
              onChange("");
            }
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
      </div>
      <span id={`${id}-hint`} className="sr-only">
        Start typing; part of a name is enough.
      </span>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}

      {showList && (
        <ul id={listId} role="listbox" className="combo-list" aria-label="Matching symbols">
          {isError && <li className="combo-note">Search failed. Keep typing to try again.</li>}
          {!isError && hits.length === 0 && (
            <li className="combo-note">{isFetching || query !== text ? "Searching…" : "No matching symbols."}</li>
          )}
          {hits.map((hit, i) => (
            <li
              key={hit.name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className="combo-option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(hit)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="mono strong">{shortName(hit.name)}</span>
              <span className="combo-kind">{hit.route || hit.kind}</span>
              <span className="combo-path mono">{hit.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

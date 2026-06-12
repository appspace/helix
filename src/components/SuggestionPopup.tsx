import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../theme';

export type SuggestionKind = 'column' | 'table' | 'alias' | 'keyword';

export interface Suggestion {
  /** Identifier inserted into the editor when accepted. */
  insert: string;
  /** Text shown as the primary line in the list. */
  label: string;
  /** Secondary line (e.g. table name for a column, or column type). */
  detail?: string;
  kind: SuggestionKind;
}

interface SuggestionPopupProps {
  items: Suggestion[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onAccept: (item: Suggestion) => void;
  /** Position relative to the popup's positioned ancestor. */
  position: { left: number; top: number };
  t: Theme;
}

const MAX_VISIBLE = 8;
const ITEM_HEIGHT = 32;

export function SuggestionPopup({ items, selectedIndex, onHover, onAccept, position, t }: SuggestionPopupProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view when arrow keys walk past the visible window.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.children[selectedIndex] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  const s = {
    root: {
      position: 'absolute', left: position.left, top: position.top, zIndex: 50,
      background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 5,
      boxShadow: t.shadowLg, overflow: 'hidden',
      fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 12, minWidth: 220,
    } as CSSProperties,
    list: {
      maxHeight: ITEM_HEIGHT * MAX_VISIBLE, overflowY: 'auto',
    } as CSSProperties,
    row: (active: boolean): CSSProperties => ({
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 10px',
      height: ITEM_HEIGHT, boxSizing: 'border-box',
      background: active ? t.bgSelected : 'transparent',
      borderLeft: active ? `2px solid ${t.accent}` : `2px solid transparent`,
      cursor: 'pointer',
    }),
    label: (kind: SuggestionKind): CSSProperties => ({
      color: kind === 'keyword' ? t.sqlKeyword : t.textPrimary,
      fontFamily: '"JetBrains Mono", monospace',
      fontWeight: kind === 'keyword' ? 600 : 400,
    }),
    detail: { color: t.textMuted, fontSize: 11, marginLeft: 'auto', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
    iconWrap: { width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: t.textMuted, flexShrink: 0 } as CSSProperties,
    footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 10px', borderTop: `1px solid ${t.borderSubtle}`, background: t.bgToolbar, color: t.textMuted, fontSize: 10 } as CSSProperties,
  };

  return (
    <div style={s.root} role="listbox" onMouseDown={(e) => e.preventDefault()}>
      <div ref={listRef} style={s.list}>
        {items.map((item, i) => (
          <div
            key={`${item.kind}:${item.insert}:${i}`}
            role="option"
            aria-selected={i === selectedIndex}
            style={s.row(i === selectedIndex)}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onAccept(item); }}
          >
            <span style={s.iconWrap}><KindIcon kind={item.kind} /></span>
            <span style={s.label(item.kind)}>{item.label}</span>
            {item.detail && <span style={s.detail}>{item.detail}</span>}
          </div>
        ))}
      </div>
      <div style={s.footer}>
        <span>↑↓ navigate</span>
        <span>Tab / Enter accept</span>
        <span>Esc close</span>
      </div>
    </div>
  );
}

function KindIcon({ kind }: { kind: SuggestionKind }) {
  if (kind === 'keyword') {
    // Square brackets evoke the angle-bracket / keyword shorthand used in syntax docs.
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 4 4 4 4 20 9 20"/><polyline points="15 4 20 4 20 20 15 20"/>
      </svg>
    );
  }
  if (kind === 'table') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="4" x2="9" y2="20"/>
      </svg>
    );
  }
  if (kind === 'alias') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h16M4 12h10M4 17h16"/>
      </svg>
    );
  }
  // column
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="6" height="16" rx="1"/><rect x="14" y="4" width="6" height="16" rx="1"/>
    </svg>
  );
}

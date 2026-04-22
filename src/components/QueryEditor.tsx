import { useEffect, useRef, useState, CSSProperties } from 'react';
import type { Theme } from '../theme';
import type { HistoryEntry } from '../queryHistory';

interface QueryEditorProps {
  value: string;
  onChange: (val: string) => void;
  onRun: () => void;
  isRunning: boolean;
  activeSchema: string;
  history?: HistoryEntry[];
  onReopenHistory?: (entry: HistoryEntry) => void;
  onDeleteHistoryEntry?: (id: string) => void;
  onClearHistory?: () => void;
  t: Theme;
}

function formatRelative(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function oneLine(sql: string, max = 120): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const ToolBtn = ({ title, onClick, children, t }: { title: string; onClick?: () => void; children: React.ReactNode; t: Theme }) => (
  <button
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'none', border: 'none', borderRadius: 5, cursor: 'pointer', color: t.textMuted }}
    title={title}
    onClick={onClick}
  >
    {children}
  </button>
);

export function QueryEditor({
  value, onChange, onRun, isRunning, activeSchema,
  history = [], onReopenHistory, onDeleteHistoryEntry, onClearHistory,
  t,
}: QueryEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!historyOpen) return;
    const onClick = (e: MouseEvent) => {
      if (historyAnchorRef.current && !historyAnchorRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHistoryOpen(false); };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [historyOpen]);

  const now = Date.now();

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onRun();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = value.substring(0, start) + '  ' + value.substring(end);
      onChange(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; });
    }
  };

  const s = {
    root: { display: 'flex', flexDirection: 'column', background: t.bgSurface, borderBottom: `1px solid ${t.border}` } as CSSProperties,
    toolbar: { display: 'flex', alignItems: 'center', gap: 2, padding: '5px 10px', borderBottom: `1px solid ${t.border}`, flexShrink: 0, background: t.bgToolbar } as CSSProperties,
    runBtn: { display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 12px', background: t.accent, color: t.textInverse, border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: '"IBM Plex Sans", sans-serif', cursor: 'pointer' } as CSSProperties,
    sep: { width: 1, height: 18, background: t.border, margin: '0 4px' } as CSSProperties,
    schemaPill: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: t.textSecondary, fontFamily: 'monospace', background: t.bgElevated, border: `1px solid ${t.border}`, padding: '3px 9px', borderRadius: 4 } as CSSProperties,
    editorWrap: { flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 } as CSSProperties,
    lineNums: { background: t.bgToolbar, borderRight: `1px solid ${t.borderSubtle}`, padding: '12px 0', minWidth: 40, textAlign: 'right', userSelect: 'none', flexShrink: 0, overflowY: 'hidden' } as CSSProperties,
    lineNum: { padding: '0 10px', fontSize: 11, lineHeight: '21px', color: t.textMuted, fontFamily: '"JetBrains Mono", monospace' } as CSSProperties,
    textarea: { flex: 1, background: 'transparent', border: 'none', outline: 'none', resize: 'none', padding: '12px 16px', color: t.textPrimary, fontFamily: '"JetBrains Mono", monospace', fontSize: 13, lineHeight: '21px', caretColor: t.accent, overflowY: 'auto' } as CSSProperties,
  };

  return (
    <div style={s.root}>
      <div style={s.toolbar}>
        <button style={{ ...s.runBtn, opacity: isRunning ? 0.85 : 1 }} onClick={onRun}>
          {isRunning
            ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="6" width="12" height="12"/></svg>
            : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>}
          {isRunning ? 'Stop' : 'Run'}
          <span style={{ fontSize: 10, opacity: 0.65 }}>⌘↵</span>
        </button>
        <div style={s.sep}/>
        <ToolBtn title="Format SQL" t={t}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/>
          </svg>
        </ToolBtn>
        <ToolBtn title="Save query" t={t}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
          </svg>
        </ToolBtn>
        <div ref={historyAnchorRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setHistoryOpen(o => !o)}
            title={history.length > 0 ? `Query history (${history.length})` : 'Query history — empty'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, background: historyOpen ? t.bgSurface : 'none',
              border: 'none', borderRadius: 5, cursor: 'pointer',
              color: historyOpen ? t.textPrimary : t.textMuted,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15" y2="15"/>
            </svg>
          </button>
          {historyOpen && (
            <div
              role="listbox"
              style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
                width: 440, maxHeight: 340, overflowY: 'auto',
                background: t.bgElevated, border: `1px solid ${t.border}`,
                borderRadius: 6, boxShadow: t.shadowLg, padding: 4,
                fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 12,
              }}
            >
              {history.length === 0 && (
                <div style={{ padding: '14px 12px', fontSize: 12, color: t.textMuted, fontStyle: 'italic' }}>
                  No recent queries for this connection.
                </div>
              )}
              {history.map(entry => (
                <div
                  key={entry.id}
                  onClick={() => { onReopenHistory?.(entry); setHistoryOpen(false); }}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 3,
                    padding: '8px 10px', borderRadius: 4, cursor: 'pointer',
                    borderLeft: `3px solid ${entry.status === 'ok' ? t.colorSuccess : t.colorError}`,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = t.bgHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <div style={{
                    fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5, lineHeight: 1.4,
                    color: t.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{oneLine(entry.sql)}</div>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 10, color: t.textMuted,
                  }}>
                    <span>{formatRelative(entry.executedAt, now)}</span>
                    <span>·</span>
                    <span style={{ fontFamily: 'monospace' }}>{entry.schema || '—'}</span>
                    {entry.status === 'ok' && (<>
                      <span>·</span>
                      <span>{entry.durationMs !== null ? `${entry.durationMs}ms` : '—'}</span>
                      {entry.rowCount !== undefined && (<>
                        <span>·</span>
                        <span>{entry.rowCount} rows</span>
                      </>)}
                    </>)}
                    {entry.status === 'error' && (<>
                      <span>·</span>
                      <span style={{ color: t.colorError, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{entry.error}</span>
                    </>)}
                    {onDeleteHistoryEntry && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteHistoryEntry(entry.id); }}
                        title="Remove from history"
                        style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: t.textMuted, cursor: 'pointer', padding: 2, fontSize: 11 }}
                      >×</button>
                    )}
                  </div>
                </div>
              ))}
              {history.length > 0 && onClearHistory && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 6px', borderTop: `1px solid ${t.borderSubtle}`, marginTop: 4 }}>
                  <button
                    onClick={() => { onClearHistory(); setHistoryOpen(false); }}
                    style={{
                      padding: '4px 10px', fontSize: 11, fontFamily: 'inherit',
                      background: 'transparent', color: t.textMuted,
                      border: 'none', borderRadius: 3, cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = t.colorError; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = t.textMuted; }}
                  >Clear history</button>
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ flex: 1 }}/>
        <span style={s.schemaPill}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
          {activeSchema}
        </span>
      </div>
      <div style={s.editorWrap}>
        <div style={s.lineNums} aria-hidden="true">
          {value.split('\n').map((_, i) => (
            <div key={i} style={s.lineNum}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          style={s.textarea}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, CSSProperties } from 'react';
import { format as formatSql } from 'sql-formatter';
import type { Theme } from '../theme';
import type { HistoryEntry } from '../queryHistory';
import type { SavedQuery } from '../savedQueries';

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
  savedQueries?: SavedQuery[];
  onSaveQuery?: (name: string, sql: string, schema: string) => void;
  onDeleteSavedQuery?: (id: string) => void;
  onRenameSavedQuery?: (id: string, name: string) => void;
  onReopenSavedQuery?: (query: SavedQuery) => void;
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

const ToolBtn = ({ title, onClick, active, children, t }: { title: string; onClick?: () => void; active?: boolean; children: React.ReactNode; t: Theme }) => (
  <button
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: active ? t.bgSurface : 'none', border: 'none', borderRadius: 5, cursor: 'pointer', color: active ? t.textPrimary : t.textMuted }}
    aria-label={title}
    data-tooltip={title}
    onClick={onClick}
  >
    {children}
  </button>
);

export function QueryEditor({
  value, onChange, onRun, isRunning, activeSchema,
  history = [], onReopenHistory, onDeleteHistoryEntry, onClearHistory,
  savedQueries = [], onSaveQuery, onDeleteSavedQuery, onRenameSavedQuery, onReopenSavedQuery,
  t,
}: QueryEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const historyAnchorRef = useRef<HTMLDivElement>(null);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const saveAnchorRef = useRef<HTMLDivElement>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);

  const [savedOpen, setSavedOpen] = useState(false);
  const savedAnchorRef = useRef<HTMLDivElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!historyOpen) return;
    const onClick = (e: MouseEvent) => {
      if (historyAnchorRef.current && !historyAnchorRef.current.contains(e.target as Node))
        setHistoryOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHistoryOpen(false); };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', onClick); window.removeEventListener('keydown', onKey); };
  }, [historyOpen]);

  useEffect(() => {
    if (!saveOpen) return;
    const onClick = (e: MouseEvent) => {
      if (saveAnchorRef.current && !saveAnchorRef.current.contains(e.target as Node))
        setSaveOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSaveOpen(false); };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', onClick); window.removeEventListener('keydown', onKey); };
  }, [saveOpen]);

  useEffect(() => {
    if (!savedOpen) return;
    const onClick = (e: MouseEvent) => {
      if (savedAnchorRef.current && !savedAnchorRef.current.contains(e.target as Node)) {
        setSavedOpen(false); setRenamingId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSavedOpen(false); setRenamingId(null); } };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', onClick); window.removeEventListener('keydown', onKey); };
  }, [savedOpen]);

  useEffect(() => {
    if (saveOpen) { saveInputRef.current?.focus(); saveInputRef.current?.select(); }
  }, [saveOpen]);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  const handleSave = () => {
    const name = saveName.trim();
    if (!name || !onSaveQuery) return;
    onSaveQuery(name, value, activeSchema);
    setSaveOpen(false);
    setSaveName('');
  };

  const handleRenameCommit = (id: string) => {
    const name = renameValue.trim();
    if (name) onRenameSavedQuery?.(id, name);
    setRenamingId(null);
  };

  const now = Date.now();

  const [formatError, setFormatError] = useState<string | null>(null);

  const handleFormat = () => {
    if (!value.trim()) return;
    try {
      const formatted = formatSql(value, { language: 'mysql', keywordCase: 'upper', tabWidth: 2 });
      if (formatted !== value) onChange(formatted);
      setFormatError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      handleFormatError(message);
    }
  };

  const handleFormatError = (message: string) => {
    const pos = message.match(/at line (\d+) column (\d+)/i);
    if (!pos) { setFormatError(message); return; }

    const line = Number(pos[1]);
    const col = Number(pos[2]);
    const lines = value.split('\n');

    let lineStart = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) lineStart += lines[i].length + 1;
    const lineText = lines[line - 1] ?? '';
    const lineEnd = lineStart + lineText.length;
    const caret = Math.min(lineStart + Math.max(0, col - 1), lineEnd);

    const snippetLen = 48;
    const snippetStart = Math.max(lineStart, caret - Math.floor(snippetLen / 2));
    const snippetEnd = Math.min(lineEnd, snippetStart + snippetLen);
    const snippetPrefix = snippetStart > lineStart ? '…' : '';
    const snippetSuffix = snippetEnd < lineEnd ? '…' : '';
    const snippetBody = value.substring(snippetStart, caret) + '▸' + value.substring(caret, snippetEnd);
    const snippet = snippetPrefix + snippetBody + snippetSuffix;

    const enriched = `${message}\nNear (line ${line}): ${snippet}`;
    setFormatError(enriched);

    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(lineStart, lineEnd);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onRun();
      return;
    }
    if (e.shiftKey && e.altKey && e.code === 'KeyF') {
      e.preventDefault();
      handleFormat();
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
    panel: {
      position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
      width: 440, maxHeight: 400, overflowY: 'auto',
      background: t.bgElevated, border: `1px solid ${t.border}`,
      borderRadius: 6, boxShadow: t.shadowLg, padding: 4,
      fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 12,
    } as CSSProperties,
  };

  return (
    <div style={s.root}>
      <div style={s.toolbar}>
        <button style={{ ...s.runBtn, opacity: isRunning ? 0.85 : 1 }} onClick={onRun} data-tooltip={isRunning ? 'Stop query' : 'Run query (⌘↵)'}>
          {isRunning
            ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="6" width="12" height="12"/></svg>
            : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>}
          {isRunning ? 'Stop' : 'Run'}
          <span style={{ fontSize: 10, opacity: 0.65 }}>⌘↵</span>
        </button>
        <div style={s.sep}/>
        <ToolBtn title="Format SQL (⇧⌥F)" t={t} onClick={handleFormat}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/>
          </svg>
        </ToolBtn>

        {/* Save query button + popover */}
        <div ref={saveAnchorRef} style={{ position: 'relative' }}>
          <ToolBtn
            title="Save query"
            active={saveOpen}
            t={t}
            onClick={() => { setSaveOpen(o => !o); setSavedOpen(false); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
            </svg>
          </ToolBtn>
          {saveOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
                width: 280, background: t.bgElevated, border: `1px solid ${t.border}`,
                borderRadius: 6, boxShadow: t.shadowLg, padding: 12,
                fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 600, color: t.textPrimary, marginBottom: 8 }}>Save query</div>
              <input
                ref={saveInputRef}
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
                  else if (e.key === 'Escape') setSaveOpen(false);
                }}
                placeholder="Query name"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '6px 8px', marginBottom: 8,
                  background: t.bgBase, color: t.textPrimary,
                  border: `1px solid ${t.border}`, borderRadius: 3, outline: 'none',
                  fontSize: 12, fontFamily: 'inherit',
                }}
              />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setSaveOpen(false)}
                  style={{ padding: '4px 10px', fontSize: 11, fontFamily: 'inherit', background: 'transparent', color: t.textMuted, border: `1px solid ${t.border}`, borderRadius: 3, cursor: 'pointer' }}
                >Cancel</button>
                <button
                  onClick={handleSave}
                  disabled={!saveName.trim()}
                  style={{ padding: '4px 10px', fontSize: 11, fontFamily: 'inherit', background: t.accent, color: '#fff', border: 'none', borderRadius: 3, cursor: saveName.trim() ? 'pointer' : 'not-allowed', opacity: saveName.trim() ? 1 : 0.5 }}
                >Save</button>
              </div>
            </div>
          )}
        </div>

        {/* Saved queries browser */}
        <div ref={savedAnchorRef} style={{ position: 'relative' }}>
          <ToolBtn
            title={savedQueries.length > 0 ? `Saved queries (${savedQueries.length})` : 'Saved queries — empty'}
            active={savedOpen}
            t={t}
            onClick={() => { setSavedOpen(o => !o); setSaveOpen(false); setRenamingId(null); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
          </ToolBtn>
          {savedOpen && (
            <div role="listbox" style={s.panel}>
              {savedQueries.length === 0 && (
                <div style={{ padding: '14px 12px', fontSize: 12, color: t.textMuted, fontStyle: 'italic' }}>
                  No saved queries for this connection.
                </div>
              )}
              {savedQueries.map(q => (
                <div
                  key={q.id}
                  style={{ padding: '8px 10px', borderRadius: 4, borderLeft: `3px solid ${t.accent}`, marginBottom: 2 }}
                  onMouseEnter={(e) => { if (renamingId !== q.id) e.currentTarget.style.background = t.bgHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {renamingId === q.id ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); handleRenameCommit(q.id); }
                        else if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
                      }}
                      onBlur={() => handleRenameCommit(q.id)}
                      style={{
                        width: '100%', boxSizing: 'border-box', padding: '3px 6px', marginBottom: 4,
                        background: t.bgBase, color: t.textPrimary,
                        border: `1px solid ${t.accent}`, borderRadius: 3, outline: 'none',
                        fontSize: 12, fontFamily: 'inherit',
                      }}
                    />
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                      <span style={{ fontWeight: 600, color: t.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {q.name}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setRenamingId(q.id); setRenameValue(q.name); }}
                        title="Rename"
                        style={{ border: 'none', background: 'transparent', color: t.textMuted, cursor: 'pointer', padding: 2, lineHeight: 1, display: 'flex', alignItems: 'center' }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = t.textPrimary; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = t.textMuted; }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteSavedQuery?.(q.id); }}
                        title="Delete"
                        style={{ border: 'none', background: 'transparent', color: t.textMuted, cursor: 'pointer', padding: '2px 4px', fontSize: 13, lineHeight: 1 }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = t.colorError; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = t.textMuted; }}
                      >×</button>
                    </div>
                  )}
                  <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: t.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 4 }}>
                    {oneLine(q.sql)}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: t.textMuted }}>
                    <span style={{ fontFamily: 'monospace' }}>{q.schema || '—'}</span>
                    <span>·</span>
                    <span>{formatRelative(q.savedAt, now)}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); onReopenSavedQuery?.(q); setSavedOpen(false); }}
                      style={{
                        marginLeft: 'auto', padding: '2px 8px', fontSize: 10, fontFamily: 'inherit',
                        background: t.bgSurface, color: t.textSecondary,
                        border: `1px solid ${t.border}`, borderRadius: 3, cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = t.accent; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = t.accent; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = t.bgSurface; e.currentTarget.style.color = t.textSecondary; e.currentTarget.style.borderColor = t.border; }}
                    >Open</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* History */}
        <div ref={historyAnchorRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setHistoryOpen(o => !o)}
            aria-label={history.length > 0 ? `Query history (${history.length})` : 'Query history — empty'}
            data-tooltip={history.length > 0 ? `Query history (${history.length})` : 'Query history — empty'}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: t.textMuted }}>
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
                    style={{ padding: '4px 10px', fontSize: 11, fontFamily: 'inherit', background: 'transparent', color: t.textMuted, border: 'none', borderRadius: 3, cursor: 'pointer' }}
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
      {formatError && (() => {
        const [headline, ...rest] = formatError.split('\n');
        const nearLine = rest.find(l => l.startsWith('Near'));
        return (
        <div
          role="alert"
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '6px 10px',
            fontSize: 11, lineHeight: 1.45,
            fontFamily: '"IBM Plex Sans", sans-serif',
            background: t.bgElevated, color: t.colorError,
            borderBottom: `1px solid ${t.border}`,
            wordBreak: 'break-word', overflowWrap: 'anywhere',
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Format failed: {headline}</span>
            {nearLine && (
              <span style={{ fontFamily: '"JetBrains Mono", monospace', color: t.textSecondary, fontSize: 10.5 }}>
                {nearLine}
              </span>
            )}
          </div>
          <button
            onClick={() => setFormatError(null)}
            aria-label="Dismiss"
            style={{
              background: 'none', border: 'none', color: t.textMuted,
              cursor: 'pointer', padding: 0, lineHeight: 1,
              fontFamily: 'inherit', fontSize: 14, flexShrink: 0,
            }}
          >×</button>
        </div>
        );
      })()}
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

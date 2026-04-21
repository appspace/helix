import { useRef, CSSProperties } from 'react';
import type { Theme } from '../theme';

interface QueryEditorProps {
  value: string;
  onChange: (val: string) => void;
  onRun: () => void;
  isRunning: boolean;
  activeSchema: string;
  t: Theme;
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

export function QueryEditor({ value, onChange, onRun, isRunning, activeSchema, t }: QueryEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    root: { display: 'flex', flexDirection: 'column', background: t.bgSurface, borderBottom: `1px solid ${t.border}`, overflow: 'hidden' } as CSSProperties,
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
        <ToolBtn title="Query history" t={t}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15" y2="15"/>
          </svg>
        </ToolBtn>
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

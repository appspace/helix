import { useEffect, useState, CSSProperties } from 'react';
import type { Theme } from '../theme';
import { api } from '../api';
import type { ObjectType } from '../api';

const DIALOG_TITLE: Record<ObjectType, string> = {
  table:     'Table schema',
  view:      'View definition',
  procedure: 'Procedure definition',
  trigger:   'Trigger definition',
};

interface ShowSchemaDialogProps {
  schema: string;
  name: string;
  type: ObjectType;
  onClose: () => void;
  t: Theme;
}

export function ShowSchemaDialog({ schema, name, type, onClose, t }: ShowSchemaDialogProps) {
  const [ddl, setDdl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDdl(null);
    setError(null);
    api.tableDdl(schema, name, type)
      .then(res => { if (!cancelled) setDdl(res.ddl); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [schema, name, type]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const onCopy = async () => {
    if (!ddl) return;
    try {
      await navigator.clipboard.writeText(ddl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Clipboard copy failed — select and copy manually.');
    }
  };

  const s = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 } as CSSProperties,
    modal: { background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 8, width: 720, maxWidth: '92vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', fontFamily: '"IBM Plex Sans", sans-serif', color: t.textPrimary, boxShadow: '0 10px 40px rgba(0,0,0,0.4)' } as CSSProperties,
    header: { padding: '14px 20px', borderBottom: `1px solid ${t.borderSubtle}`, display: 'flex', alignItems: 'baseline', gap: 10 } as CSSProperties,
    title: { margin: 0, fontSize: 14, fontWeight: 600 } as CSSProperties,
    subtitle: { fontSize: 11, color: t.textMuted, fontFamily: 'monospace' } as CSSProperties,
    body: { padding: 14, overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 10 } as CSSProperties,
    pre: { margin: 0, padding: '12px 14px', background: t.bgBase, border: `1px solid ${t.borderSubtle}`, borderRadius: 4, fontSize: 11.5, lineHeight: 1.55, fontFamily: '"JetBrains Mono", monospace', color: t.textPrimary, whiteSpace: 'pre', overflowX: 'auto' } as CSSProperties,
    errorBanner: { padding: '8px 10px', background: t.colorErrorBg, border: `1px solid ${t.colorErrorBorder}`, borderRadius: 4, fontSize: 11, color: t.colorError, fontFamily: 'monospace' } as CSSProperties,
    footer: { padding: '12px 16px', borderTop: `1px solid ${t.borderSubtle}`, display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' } as CSSProperties,
    btnPrimary: { padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: t.accent, color: '#fff', border: 'none', borderRadius: 4, cursor: ddl ? 'pointer' : 'not-allowed', opacity: ddl ? 1 : 0.5, display: 'flex', alignItems: 'center', gap: 6 } as CSSProperties,
    btnSecondary: { padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: 'transparent', color: t.textSecondary, border: `1px solid ${t.border}`, borderRadius: 4, cursor: 'pointer' } as CSSProperties,
    spinner: { width: 18, height: 18, border: `2px solid ${t.spinnerTrack}`, borderTop: `2px solid ${t.spinnerHead}`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' } as CSSProperties,
    loading: { display: 'flex', alignItems: 'center', gap: 10, padding: 24, justifyContent: 'center', color: t.textMuted, fontSize: 12 } as CSSProperties,
  };

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <h3 style={s.title}>{DIALOG_TITLE[type]}</h3>
          <span style={s.subtitle}>{schema}.{name}</span>
        </div>

        <div style={s.body}>
          {error && <div style={s.errorBanner}>{error}</div>}
          {!error && ddl === null && (
            <div style={s.loading}>
              <div style={s.spinner}/>
              <span>Loading DDL…</span>
            </div>
          )}
          {ddl !== null && <pre style={s.pre}>{ddl}</pre>}
        </div>

        <div style={s.footer}>
          <button type="button" onClick={onClose} style={s.btnSecondary}>Close</button>
          <button type="button" onClick={onCopy} style={s.btnPrimary} disabled={!ddl}>
            {copied
              ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied</>
              : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}

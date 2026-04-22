import { useState, useEffect, useMemo, CSSProperties } from 'react';
import type { Theme } from '../theme';
import type { SchemaColumn } from '../api';

type CellValue = string | number | null;
type EditKind = 'number' | 'date' | 'datetime' | 'time' | 'text';

function editKindForDataType(dataType: string): EditKind {
  switch (dataType) {
    case 'tinyint': case 'smallint': case 'mediumint': case 'int': case 'bigint':
    case 'decimal': case 'float': case 'double': case 'year':
      return 'number';
    case 'date':
      return 'date';
    case 'datetime': case 'timestamp':
      return 'datetime';
    case 'time':
      return 'time';
    default:
      return 'text';
  }
}

function toDatetimeLocal(v: string): string {
  return v.replace(' ', 'T').slice(0, 16);
}
function fromDatetimeLocal(v: string): string {
  return v.replace('T', ' ');
}

interface InsertRowDialogProps {
  table: string;
  columns: SchemaColumn[];
  onSubmit: (values: Record<string, CellValue>) => Promise<void>;
  onClose: () => void;
  t: Theme;
}

export function InsertRowDialog({ table, columns, onSubmit, onClose, t }: InsertRowDialogProps) {
  // Editable columns = not auto-increment; auto-increment columns are skipped entirely (server assigns)
  const editable = useMemo(() => columns.filter(c => !c.autoIncrement), [columns]);
  const initialDrafts = useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of editable) out[c.name] = '';
    return out;
  }, [editable]);

  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);
  const [view, setView] = useState<'form' | 'confirm'>('form');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, saving]);

  // Translate the drafts into the values we'll send. A blank input means:
  //   - autoIncrement / has default  → omit (let MySQL fill in)
  //   - nullable                      → NULL
  //   - required (NOT NULL, no default) → validation error
  const buildPayload = (): { values: Record<string, CellValue>; missing: string[] } => {
    const values: Record<string, CellValue> = {};
    const missing: string[] = [];
    for (const c of editable) {
      const raw = drafts[c.name];
      const kind = editKindForDataType(c.dataType);
      if (raw === '' || raw === undefined) {
        if (c.default !== null) continue; // server-side default will fill in
        if (c.nullable) { values[c.name] = null; continue; }
        missing.push(c.name);
        continue;
      }
      if (kind === 'number') values[c.name] = Number(raw);
      else if (kind === 'datetime') values[c.name] = fromDatetimeLocal(raw);
      else values[c.name] = raw;
    }
    return { values, missing };
  };

  const { values: pendingValues, missing: missingRequired } = view === 'confirm'
    ? buildPayload()
    : { values: {} as Record<string, CellValue>, missing: [] as string[] };

  const goToConfirm = () => {
    const { missing } = buildPayload();
    if (missing.length > 0) {
      setError(`Required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
      return;
    }
    setError(null);
    setView('confirm');
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSubmit(pendingValues);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setView('form');
    } finally {
      setSaving(false);
    }
  };

  const s = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 } as CSSProperties,
    modal: { background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 8, minWidth: 520, maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column', fontFamily: '"IBM Plex Sans", sans-serif', color: t.textPrimary, boxShadow: '0 10px 40px rgba(0,0,0,0.4)' } as CSSProperties,
    header: { padding: '16px 20px', borderBottom: `1px solid ${t.borderSubtle}`, display: 'flex', alignItems: 'baseline', gap: 10 } as CSSProperties,
    title: { margin: 0, fontSize: 14, fontWeight: 600 } as CSSProperties,
    subtitle: { fontSize: 11, color: t.textMuted, fontFamily: 'monospace' } as CSSProperties,
    body: { padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 } as CSSProperties,
    row: { display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, alignItems: 'start' } as CSSProperties,
    label: { fontSize: 12, color: t.textSecondary, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingTop: 6 } as CSSProperties,
    labelMuted: { fontSize: 10, color: t.textMuted, fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
    input: { width: '100%', boxSizing: 'border-box', padding: '6px 10px', background: t.bgSurface, color: t.textPrimary, border: `1px solid ${t.border}`, outline: 'none', borderRadius: 3, fontFamily: '"JetBrains Mono", monospace', fontSize: 12 } as CSSProperties,
    helper: { fontSize: 10, color: t.textMuted, marginTop: 3, lineHeight: 1.35 } as CSSProperties,
    footer: { padding: '12px 16px', borderTop: `1px solid ${t.borderSubtle}`, display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' } as CSSProperties,
    errorBanner: { padding: '8px 10px', background: t.colorErrorBg, border: `1px solid ${t.colorErrorBorder}`, borderRadius: 4, fontSize: 11, color: t.colorError, fontFamily: 'monospace', margin: '0 16px' } as CSSProperties,
    pre: { margin: '0 16px', padding: '10px 12px', background: t.bgBase, border: `1px solid ${t.borderSubtle}`, borderRadius: 4, fontSize: 11, fontFamily: '"JetBrains Mono", monospace', color: t.textPrimary, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } as CSSProperties,
    btnPrimary: { padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: t.accent, color: '#fff', border: 'none', borderRadius: 4, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 } as CSSProperties,
    btnSecondary: { padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: 'transparent', color: t.textSecondary, border: `1px solid ${t.border}`, borderRadius: 4, cursor: saving ? 'not-allowed' : 'pointer' } as CSSProperties,
  };

  const previewSql = (): string => {
    const cols = Object.keys(pendingValues);
    if (cols.length === 0) return `INSERT INTO \`${table}\` () VALUES ();`;
    const colList = cols.map(c => `\`${c}\``).join(', ');
    const valList = cols.map(c => {
      const v = pendingValues[c];
      return v === null ? 'NULL' : JSON.stringify(v);
    }).join(', ');
    return `INSERT INTO \`${table}\`\n  (${colList})\nVALUES\n  (${valList});`;
  };

  return (
    <div style={s.overlay} onClick={() => !saving && onClose()}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <h3 style={s.title}>Insert row</h3>
          <span style={s.subtitle}>{table}</span>
        </div>

        {view === 'form' && (
          <>
            <div style={s.body}>
              {editable.length === 0 && (
                <div style={{ fontSize: 12, color: t.textMuted }}>
                  This table has no user-editable columns (all auto-generated).
                </div>
              )}
              {editable.map(col => {
                const kind = editKindForDataType(col.dataType);
                const inputType = kind === 'number' ? 'number'
                  : kind === 'date' ? 'date'
                  : kind === 'datetime' ? 'datetime-local'
                  : kind === 'time' ? 'time'
                  : 'text';
                const required = !col.nullable && col.default === null;
                return (
                  <div key={col.name} style={s.row}>
                    <div>
                      <div style={s.label} title={col.comment || undefined}>
                        {col.name}
                        {required && <span style={{ color: t.colorError, marginLeft: 3 }}>*</span>}
                      </div>
                      <div style={s.labelMuted}>{col.type}{col.pk ? ' · PK' : ''}</div>
                    </div>
                    <div>
                      <input
                        type={inputType}
                        value={drafts[col.name] ?? ''}
                        step={kind === 'number' ? 'any' : undefined}
                        onChange={(e) => setDrafts(p => ({ ...p, [col.name]: e.target.value }))}
                        placeholder={
                          col.default !== null ? `default: ${col.default}` :
                          col.nullable ? 'NULL' :
                          ''
                        }
                        style={s.input}
                      />
                      {col.comment && <div style={s.helper}>{col.comment}</div>}
                    </div>
                  </div>
                );
              })}
            </div>

            {error && <div style={s.errorBanner}>{error}</div>}

            <div style={s.footer}>
              <button onClick={onClose} style={s.btnSecondary}>Cancel</button>
              <button onClick={goToConfirm} style={s.btnPrimary} disabled={editable.length === 0}>Review SQL</button>
            </div>
          </>
        )}

        {view === 'confirm' && (
          <>
            <div style={{ padding: '12px 16px 4px', fontSize: 12, color: t.textSecondary }}>This will run:</div>
            <pre style={s.pre}>{previewSql()}</pre>
            {missingRequired.length > 0 && (
              <div style={s.errorBanner}>Required columns missing: {missingRequired.join(', ')}</div>
            )}
            {error && <div style={s.errorBanner}>{error}</div>}

            <div style={s.footer}>
              <button onClick={() => { setView('form'); setError(null); }} style={s.btnSecondary} disabled={saving}>Back</button>
              <button onClick={submit} style={s.btnPrimary} disabled={saving || missingRequired.length > 0}>
                {saving ? 'Inserting…' : 'Insert'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../theme';
import type { DbType, SchemaColumn } from '../api';
import { buildAlterTableSql, type AlterTableColumn, type CreateTableColumn, type SqlDialect } from '../lib/sql';

const MYSQL_TYPES = [
  'INT', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'DATETIME', 'TIMESTAMP', 'BOOLEAN', 'DECIMAL(10,2)', 'JSON',
];
const POSTGRES_TYPES = [
  'INTEGER', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'TIMESTAMP', 'TIMESTAMPTZ', 'BOOLEAN', 'NUMERIC(10,2)', 'JSONB',
];

function dialectFor(dbType: DbType): SqlDialect {
  return dbType === 'postgres' ? 'postgres' : 'mysql';
}

interface Props {
  dbType: DbType;
  schema: string;
  table: string;
  columns: SchemaColumn[];
  onSubmit: (sql: string) => Promise<void>;
  onClose: () => void;
  t: Theme;
}

export function AlterTableDialog({ dbType, schema, table, columns, onSubmit, onClose, t }: Props) {
  const dialect = dialectFor(dbType);
  const typeOptions = dialect === 'postgres' ? POSTGRES_TYPES : MYSQL_TYPES;

  const [cols, setCols] = useState<AlterTableColumn[]>(() =>
    columns.map(c => ({
      originalName: c.name,
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      default: c.default,
      autoIncrement: c.autoIncrement,
      pk: c.pk,
      dropped: false,
    }))
  );
  const [sqlOverride, setSqlOverride] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const original: CreateTableColumn[] = useMemo(() =>
    columns.map(c => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      default: c.default,
      autoIncrement: c.autoIncrement,
      pk: c.pk,
    })),
    [columns],
  );

  const stmts = useMemo(
    () => buildAlterTableSql(dialect, schema || null, table, cols, original),
    [dialect, schema, table, cols, original],
  );

  const previewSql = sqlOverride ?? (stmts.length > 0 ? stmts.join('\n') : '');

  const updateCol = (i: number, patch: Partial<AlterTableColumn>) =>
    setCols(cs => cs.map((c, idx) => idx === i ? { ...c, ...patch } : c));

  const addColumn = () => setCols(cs => [
    ...cs,
    { originalName: null, name: '', type: typeOptions[0], nullable: true, default: null, autoIncrement: false, pk: false, dropped: false },
  ]);

  const removeNew = (i: number) => setCols(cs => cs.filter((_, idx) => idx !== i));

  const validate = (): string | null => {
    const active = cols.filter(c => !c.dropped);
    const seen = new Set<string>();
    for (const c of active) {
      if (!c.name.trim()) return 'Every column needs a name.';
      if (!c.type.trim()) return `Column "${c.name}" needs a type.`;
      if (seen.has(c.name.trim())) return `Duplicate column name: ${c.name}`;
      seen.add(c.name.trim());
    }
    return null;
  };

  const submit = async () => {
    const sql = sqlOverride ?? (stmts.length > 0 ? stmts.join('\n') : '');
    if (!sql.trim()) { setError('No changes to apply.'); return; }
    if (sqlOverride === null) {
      const v = validate();
      if (v) { setError(v); return; }
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(sql);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const s = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 } as CSSProperties,
    modal: { background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 8, minWidth: 760, maxWidth: 1000, maxHeight: '90vh', display: 'flex', flexDirection: 'column', fontFamily: '"IBM Plex Sans", sans-serif', color: t.textPrimary, boxShadow: '0 10px 40px rgba(0,0,0,0.4)' } as CSSProperties,
    header: { padding: '16px 20px', borderBottom: `1px solid ${t.borderSubtle}` } as CSSProperties,
    title: { margin: 0, fontSize: 14, fontWeight: 600 } as CSSProperties,
    subtitle: { margin: '2px 0 0', fontSize: 11, color: t.textMuted, fontFamily: 'monospace' } as CSSProperties,
    body: { padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 } as CSSProperties,
    sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 } as CSSProperties,
    sectionTitle: { fontSize: 12, color: t.textSecondary, fontWeight: 600, fontFamily: 'monospace' } as CSSProperties,
    columnsTable: { display: 'grid', gridTemplateColumns: '1fr 1fr 50px 1fr 28px', gap: 6, alignItems: 'center', fontSize: 11 } as CSSProperties,
    colHead: { fontSize: 10, color: t.textMuted, textTransform: 'uppercase' as const, letterSpacing: 0.4, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 2 } as CSSProperties,
    input: { padding: '6px 10px', background: t.bgSurface, color: t.textPrimary, border: `1px solid ${t.border}`, outline: 'none', borderRadius: 3, fontFamily: '"JetBrains Mono", monospace', fontSize: 12, boxSizing: 'border-box' } as CSSProperties,
    inputDropped: { opacity: 0.4, textDecoration: 'line-through' } as CSSProperties,
    iconBtn: { background: 'transparent', border: 'none', color: t.textSecondary, cursor: 'pointer', fontSize: 14, padding: 2, lineHeight: 1 } as CSSProperties,
    addBtn: { padding: '4px 10px', fontSize: 11, background: 'transparent', color: t.textSecondary, border: `1px solid ${t.border}`, borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit' } as CSSProperties,
    restoreBtn: { padding: '2px 8px', fontSize: 10, background: 'transparent', color: t.textSecondary, border: `1px solid ${t.border}`, borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit', gridColumn: '1 / -1', justifySelf: 'start' } as CSSProperties,
    pre: { width: '100%', boxSizing: 'border-box', padding: '10px 12px', background: t.bgBase, border: `1px solid ${t.borderSubtle}`, borderRadius: 4, fontSize: 11, fontFamily: '"JetBrains Mono", monospace', color: t.textPrimary, minHeight: 100, resize: 'vertical' as const } as CSSProperties,
    helper: { fontSize: 10, color: t.textMuted } as CSSProperties,
    errorBanner: { padding: '8px 10px', background: t.colorErrorBg, border: `1px solid ${t.colorErrorBorder}`, borderRadius: 4, fontSize: 11, color: t.colorError, fontFamily: 'monospace', margin: '0 16px' } as CSSProperties,
    footer: { padding: '12px 16px', borderTop: `1px solid ${t.borderSubtle}`, display: 'flex', justifyContent: 'flex-end', gap: 8 } as CSSProperties,
    btnPrimary: { padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: t.accent, color: '#fff', border: 'none', borderRadius: 4, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 } as CSSProperties,
    btnSecondary: { padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: 'transparent', color: t.textSecondary, border: `1px solid ${t.border}`, borderRadius: 4, cursor: saving ? 'not-allowed' : 'pointer' } as CSSProperties,
  };

  const qualifiedName = schema ? `${schema}.${table}` : table;

  return (
    <div style={s.overlay} onClick={() => !saving && onClose()}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <h3 style={s.title}>Alter table</h3>
          <p style={s.subtitle}>{qualifiedName}</p>
        </div>

        <div style={s.body}>
          <div style={s.sectionHeader}>
            <span style={s.sectionTitle}>Columns</span>
            <button onClick={addColumn} style={s.addBtn}>+ Add column</button>
          </div>

          <div style={s.columnsTable}>
            <div style={s.colHead}>Name</div>
            <div style={s.colHead}>Type</div>
            <div style={s.colHead}>Null</div>
            <div style={s.colHead}>Default</div>
            <div />

            {cols.map((c, i) => {
              const isNew = c.originalName === null;
              const inputStyle = { ...s.input, ...(c.dropped ? s.inputDropped : {}) };

              if (c.dropped) {
                return (
                  <>
                    <span key={`${i}-name`} style={{ ...inputStyle, padding: '6px 10px', fontSize: 12 }}>{c.originalName}</span>
                    <span key={`${i}-type`} style={{ ...inputStyle, padding: '6px 10px', fontSize: 12 }}>{c.type}</span>
                    <span key={`${i}-null`} />
                    <span key={`${i}-default`} />
                    <button
                      key={`${i}-restore`}
                      onClick={() => updateCol(i, { dropped: false })}
                      style={{ ...s.iconBtn, color: t.accent }}
                      title="Restore column"
                    >↩</button>
                  </>
                );
              }

              return (
                <>
                  <input
                    key={`${i}-name`}
                    style={s.input}
                    value={c.name}
                    onChange={(e) => updateCol(i, { name: e.target.value })}
                    placeholder="column_name"
                    readOnly={!isNew && false}
                  />
                  <input
                    key={`${i}-type`}
                    style={s.input}
                    value={c.type}
                    list="helix-alter-table-types"
                    onChange={(e) => updateCol(i, { type: e.target.value })}
                    placeholder="TYPE"
                  />
                  <input
                    key={`${i}-null`}
                    type="checkbox"
                    checked={c.nullable}
                    onChange={(e) => updateCol(i, { nullable: e.target.checked })}
                    style={{ justifySelf: 'center' }}
                    disabled={!c.nullable && c.pk}
                  />
                  <input
                    key={`${i}-default`}
                    style={s.input}
                    value={c.default ?? ''}
                    onChange={(e) => updateCol(i, { default: e.target.value || null })}
                    placeholder="(none)"
                  />
                  <button
                    key={`${i}-remove`}
                    onClick={() => isNew ? removeNew(i) : updateCol(i, { dropped: true })}
                    style={{ ...s.iconBtn, color: t.colorError }}
                    title={isNew ? 'Remove column' : 'Drop column'}
                    aria-label="Drop column"
                  >×</button>
                </>
              );
            })}
          </div>
          <datalist id="helix-alter-table-types">
            {typeOptions.map(t => <option key={t} value={t} />)}
          </datalist>

          <div style={s.sectionHeader}>
            <span style={s.sectionTitle}>SQL preview</span>
            {sqlOverride !== null && (
              <button
                style={s.addBtn}
                onClick={() => setSqlOverride(null)}
                title="Drop manual edits and rebuild from the form"
              >Reset to generated</button>
            )}
          </div>
          <textarea
            style={s.pre}
            value={previewSql}
            onChange={(e) => setSqlOverride(e.target.value)}
            spellCheck={false}
            placeholder="(no changes)"
          />
          <div style={s.helper}>
            Rename or retype columns above. For composite PKs, indexes, or foreign keys, edit the SQL directly.
          </div>
        </div>

        {error && <div style={s.errorBanner}>{error}</div>}

        <div style={s.footer}>
          <button onClick={onClose} style={s.btnSecondary} disabled={saving}>Cancel</button>
          <button onClick={submit} style={s.btnPrimary} disabled={saving}>
            {saving ? 'Applying…' : 'Alter table'}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../theme';
import type { DbType } from '../api';
import { buildCreateTableSql, type CreateTableColumn, type SqlDialect } from '../lib/sql';

const MYSQL_TYPES = [
  'INT', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'DATETIME', 'TIMESTAMP', 'BOOLEAN', 'DECIMAL(10,2)', 'JSON',
];
const POSTGRES_TYPES = [
  'INTEGER', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'TIMESTAMP', 'TIMESTAMPTZ', 'BOOLEAN', 'NUMERIC(10,2)', 'JSONB',
];

function dialectFor(dbType: DbType): SqlDialect {
  return dbType === 'postgres' ? 'postgres' : 'mysql';
}

function makeColumn(name: string, type: string, opts: Partial<CreateTableColumn> = {}): CreateTableColumn {
  return {
    name,
    type,
    nullable: opts.nullable ?? true,
    default: opts.default ?? null,
    autoIncrement: opts.autoIncrement ?? false,
    pk: opts.pk ?? false,
  };
}

function defaultColumnsFor(dialect: SqlDialect): CreateTableColumn[] {
  const intType = dialect === 'postgres' ? 'BIGINT' : 'INT';
  return [
    makeColumn('id', intType, { nullable: false, autoIncrement: true, pk: true }),
  ];
}

interface Props {
  dbType: DbType;
  initialSchema: string;
  onSubmit: (sql: string) => Promise<{ schema: string; table: string }>;
  onClose: () => void;
  t: Theme;
}

export function CreateTableDialog({ dbType, initialSchema, onSubmit, onClose, t }: Props) {
  const dialect = dialectFor(dbType);
  const typeOptions = dialect === 'postgres' ? POSTGRES_TYPES : MYSQL_TYPES;

  const [schema, setSchema] = useState(initialSchema);
  const [table, setTable] = useState('');
  const [columns, setColumns] = useState<CreateTableColumn[]>(() => defaultColumnsFor(dialect));
  const [sqlOverride, setSqlOverride] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  // Auto-generated DDL: refreshes whenever the form changes. The user can
  // override by editing the textarea — once edited, we stop auto-regenerating
  // so manual tweaks aren't blown away by a subsequent form change.
  const generatedSql = useMemo(
    () => buildCreateTableSql(dialect, schema || null, table || 'new_table', columns),
    [dialect, schema, table, columns],
  );
  const previewSql = sqlOverride ?? generatedSql;

  const updateCol = (i: number, patch: Partial<CreateTableColumn>) => {
    setColumns(cs => cs.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  };

  const setPkOn = (i: number) => {
    // v1: single-column PK only. Picking one un-picks the others.
    setColumns(cs => cs.map((c, idx) => ({ ...c, pk: idx === i })));
  };

  const addColumn = () => setColumns(cs => [...cs, makeColumn('', typeOptions[0])]);
  const removeColumn = (i: number) => setColumns(cs => cs.filter((_, idx) => idx !== i));

  const validate = (): string | null => {
    if (!table.trim()) return 'Table name is required.';
    if (columns.length === 0) return 'At least one column is required.';
    const seen = new Set<string>();
    for (const c of columns) {
      if (!c.name.trim()) return 'Every column needs a name.';
      if (!c.type.trim()) return `Column "${c.name}" needs a type.`;
      if (seen.has(c.name)) return `Duplicate column name: ${c.name}`;
      seen.add(c.name);
    }
    return null;
  };

  const submit = async () => {
    if (sqlOverride === null) {
      const v = validate();
      if (v) { setError(v); return; }
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(previewSql);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const s = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 } as CSSProperties,
    modal: { background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 8, minWidth: 720, maxWidth: 960, maxHeight: '90vh', display: 'flex', flexDirection: 'column', fontFamily: '"IBM Plex Sans", sans-serif', color: t.textPrimary, boxShadow: '0 10px 40px rgba(0,0,0,0.4)' } as CSSProperties,
    header: { padding: '16px 20px', borderBottom: `1px solid ${t.borderSubtle}` } as CSSProperties,
    title: { margin: 0, fontSize: 14, fontWeight: 600 } as CSSProperties,
    body: { padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 } as CSSProperties,
    inlineRow: { display: 'flex', gap: 8, alignItems: 'center' } as CSSProperties,
    label: { fontSize: 11, color: t.textSecondary, fontFamily: 'monospace', minWidth: 56 } as CSSProperties,
    input: { padding: '6px 10px', background: t.bgSurface, color: t.textPrimary, border: `1px solid ${t.border}`, outline: 'none', borderRadius: 3, fontFamily: '"JetBrains Mono", monospace', fontSize: 12, boxSizing: 'border-box' } as CSSProperties,
    sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 } as CSSProperties,
    sectionTitle: { fontSize: 12, color: t.textSecondary, fontWeight: 600, fontFamily: 'monospace' } as CSSProperties,
    columnsTable: { display: 'grid', gridTemplateColumns: '1fr 1fr 50px 1fr 50px 50px 28px', gap: 6, alignItems: 'center', fontSize: 11 } as CSSProperties,
    colHead: { fontSize: 10, color: t.textMuted, textTransform: 'uppercase' as const, letterSpacing: 0.4, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 2 } as CSSProperties,
    iconBtn: { background: 'transparent', border: 'none', color: t.textSecondary, cursor: 'pointer', fontSize: 14, padding: 2, lineHeight: 1 } as CSSProperties,
    addBtn: { padding: '4px 10px', fontSize: 11, background: 'transparent', color: t.textSecondary, border: `1px solid ${t.border}`, borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit' } as CSSProperties,
    pre: { width: '100%', boxSizing: 'border-box', padding: '10px 12px', background: t.bgBase, border: `1px solid ${t.borderSubtle}`, borderRadius: 4, fontSize: 11, fontFamily: '"JetBrains Mono", monospace', color: t.textPrimary, minHeight: 140, resize: 'vertical' as const } as CSSProperties,
    helper: { fontSize: 10, color: t.textMuted } as CSSProperties,
    errorBanner: { padding: '8px 10px', background: t.colorErrorBg, border: `1px solid ${t.colorErrorBorder}`, borderRadius: 4, fontSize: 11, color: t.colorError, fontFamily: 'monospace', margin: '0 16px' } as CSSProperties,
    footer: { padding: '12px 16px', borderTop: `1px solid ${t.borderSubtle}`, display: 'flex', justifyContent: 'flex-end', gap: 8 } as CSSProperties,
    btnPrimary: { padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: t.accent, color: '#fff', border: 'none', borderRadius: 4, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 } as CSSProperties,
    btnSecondary: { padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: 'transparent', color: t.textSecondary, border: `1px solid ${t.border}`, borderRadius: 4, cursor: saving ? 'not-allowed' : 'pointer' } as CSSProperties,
  };

  return (
    <div style={s.overlay} onClick={() => !saving && onClose()}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <h3 style={s.title}>Create table</h3>
        </div>

        <div style={s.body}>
          <div style={s.inlineRow}>
            <span style={s.label}>Schema</span>
            <input
              style={{ ...s.input, flex: 1 }}
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              placeholder="schema name (optional)"
            />
            <span style={s.label}>Table</span>
            <input
              style={{ ...s.input, flex: 1 }}
              value={table}
              onChange={(e) => setTable(e.target.value)}
              placeholder="table name"
              autoFocus
            />
          </div>

          <div style={s.sectionHeader}>
            <span style={s.sectionTitle}>Columns</span>
            <button onClick={addColumn} style={s.addBtn}>+ Add column</button>
          </div>

          <div style={s.columnsTable}>
            <div style={s.colHead}>Name</div>
            <div style={s.colHead}>Type</div>
            <div style={s.colHead}>Null</div>
            <div style={s.colHead}>Default</div>
            <div style={s.colHead}>A.I.</div>
            <div style={s.colHead}>PK</div>
            <div></div>

            {columns.map((c, i) => (
              <ColumnRow
                key={i}
                col={c}
                style={s}
                onChange={patch => updateCol(i, patch)}
                onSetPk={() => setPkOn(i)}
                onRemove={() => removeColumn(i)}
              />
            ))}
          </div>
          <datalist id="helix-create-table-types">
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
          />
          <div style={s.helper}>
            v1 covers single-column PK, NOT NULL, DEFAULT, auto-increment. For composite PKs, indexes,
            FKs, or per-type widgets, edit the SQL directly above before submitting.
          </div>
        </div>

        {error && <div style={s.errorBanner}>{error}</div>}

        <div style={s.footer}>
          <button onClick={onClose} style={s.btnSecondary} disabled={saving}>Cancel</button>
          <button onClick={submit} style={s.btnPrimary} disabled={saving}>
            {saving ? 'Creating…' : 'Create table'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ColumnRowProps {
  col: CreateTableColumn;
  style: Record<string, CSSProperties>;
  onChange: (patch: Partial<CreateTableColumn>) => void;
  onSetPk: () => void;
  onRemove: () => void;
}

function ColumnRow({ col, style, onChange, onSetPk, onRemove }: ColumnRowProps) {
  // The type field is a free-form input with a datalist of common types — lets
  // users pick fast and still write VARCHAR(50), DECIMAL(8,2), etc. by hand.
  return (
    <>
      <input
        style={style.input}
        value={col.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="column_name"
      />
      <input
        style={style.input}
        value={col.type}
        list="helix-create-table-types"
        onChange={(e) => onChange({ type: e.target.value })}
        placeholder="TYPE"
      />
      <input
        type="checkbox"
        checked={col.nullable}
        onChange={(e) => onChange({ nullable: e.target.checked })}
        style={{ justifySelf: 'center' }}
      />
      <input
        style={style.input}
        value={col.default ?? ''}
        onChange={(e) => onChange({ default: e.target.value || null })}
        placeholder="(none)"
      />
      <input
        type="checkbox"
        checked={col.autoIncrement}
        onChange={(e) => {
          const checked = e.target.checked;
          onChange({ autoIncrement: checked });
          if (checked) onSetPk();
        }}
        style={{ justifySelf: 'center' }}
      />
      <input
        type="checkbox"
        checked={col.pk}
        onChange={(e) => { if (e.target.checked) onSetPk(); else onChange({ pk: false }); }}
        style={{ justifySelf: 'center' }}
      />
      <button onClick={onRemove} style={style.iconBtn} title="Remove column" aria-label="Remove column">×</button>
    </>
  );
}

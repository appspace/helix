import { useState, useEffect, useRef, CSSProperties } from 'react';
import type { Theme } from '../theme';
import { ShowSchemaDialog, type ObjectType } from './ShowSchemaDialog';

interface Column {
  name: string;
  type: string;
  pk?: boolean;
  comment?: string;
}

interface Table {
  name: string;
  rows: number | string;
  comment?: string;
  columns?: Column[];
}

interface SchemaData {
  tables?: Table[];
  views?: string[];
  procedures?: string[];
  triggers?: string[];
}

interface SchemaBrowserProps {
  schema: SchemaData;
  activeTable: string | null;
  onTableSelect: (name: string) => void;
  onSchemaChange: (name: string) => void;
  schemas: string[];
  activeSchema: string;
  onDropTable?: (schema: string, table: string) => Promise<void>;
  t: Theme;
}

function CtxItem({ t, onClick, icon, label, color }: {
  t: Theme; onClick: () => void; icon: React.ReactNode;
  label: string; color?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', background: 'transparent', color: color ?? t.textPrimary, cursor: 'pointer', borderRadius: 3, fontSize: 12, fontFamily: 'inherit' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = t.bgHover; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {icon}
      </svg>
      {label}
    </button>
  );
}

const Chevron = ({ open, color }: { open: boolean; color: string }) => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    {open ? <polyline points="6 9 12 15 18 9"/> : <polyline points="9 18 15 12 9 6"/>}
  </svg>
);

interface ConfirmDrop {
  table: string;
  typedName: string;
  error: string | null;
  working: boolean;
}

export function SchemaBrowser({ schema, activeTable, onTableSelect, onSchemaChange, schemas, activeSchema, onDropTable, t }: SchemaBrowserProps) {
  const [expanded, setExpanded] = useState({ tables: true, views: false, procedures: false, triggers: false });
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; name: string; type: ObjectType } | null>(null);
  const [showSchemaFor, setShowSchemaFor] = useState<{ name: string; type: ObjectType } | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<ConfirmDrop | null>(null);
  const dropInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', key);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (confirmDrop) dropInputRef.current?.focus();
  }, [confirmDrop?.table]);

  const toggle = (key: keyof typeof expanded) => setExpanded(p => ({ ...p, [key]: !p[key] }));
  const toggleTable = (name: string) => setExpandedTables(p => ({ ...p, [name]: !p[name] }));

  const s = {
    root: { width: 224, background: t.bgSurface, borderRight: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 } as CSSProperties,
    header: { padding: '8px 10px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, background: t.bgToolbar } as CSSProperties,
    schemaSelect: { flex: 1, background: 'transparent', border: 'none', outline: 'none', font: `500 12px/1 "IBM Plex Sans", sans-serif`, color: t.textPrimary, cursor: 'pointer', minWidth: 0 } as CSSProperties,
    searchWrap: { padding: '6px 10px', borderBottom: `1px solid ${t.borderSubtle}`, display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 } as CSSProperties,
    searchInput: { flex: 1, background: 'transparent', border: 'none', outline: 'none', font: '12px "IBM Plex Sans", sans-serif', color: t.textPrimary } as CSSProperties,
    tree: { flex: 1, overflowY: 'auto', padding: '4px 0' } as CSSProperties,
    groupRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer', userSelect: 'none' } as CSSProperties,
    groupLabel: { fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, flex: 1 } as CSSProperties,
    groupCount: { fontSize: 10, color: t.textMuted } as CSSProperties,
    tableRow: { display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px 4px 18px', cursor: 'pointer', transition: 'background 100ms ease' } as CSSProperties,
    tableRowActive: { background: t.bgSelected } as CSSProperties,
    tableName: { fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
    rowCount: { fontSize: 10, color: t.textMuted, fontFamily: 'monospace' } as CSSProperties,
    colRow: { display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px 3px 32px', cursor: 'pointer' } as CSSProperties,
    colName: { fontSize: 11, color: t.textMuted, flex: 1 } as CSSProperties,
    colType: { fontSize: 10, color: t.borderStrong, fontFamily: 'monospace' } as CSSProperties,
    emptyGroup: { padding: '4px 10px 4px 28px', fontSize: 11, color: t.textMuted, fontStyle: 'italic' } as CSSProperties,
    divLine: { height: 1, background: t.borderSubtle, margin: '4px 0' } as CSSProperties,
  };

  const groups: { key: keyof typeof expanded; label: string; count: number }[] = [
    { key: 'tables',     label: 'Tables',     count: schema.tables?.length ?? 0 },
    { key: 'views',      label: 'Views',      count: schema.views?.length ?? 0 },
    { key: 'procedures', label: 'Procedures', count: schema.procedures?.length ?? 0 },
    { key: 'triggers',   label: 'Triggers',   count: schema.triggers?.length ?? 0 },
  ];

  const filteredTables = schema.tables?.filter(t => !filter || t.name.toLowerCase().includes(filter.toLowerCase())) ?? [];

  return (
    <div style={s.root}>
      <div style={s.header}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={t.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
          <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
        </svg>
        <select value={activeSchema} onChange={e => onSchemaChange(e.target.value)} style={s.schemaSelect}>
          {schemas.map(sc => <option key={sc} value={sc}>{sc}</option>)}
        </select>
      </div>

      <div style={s.searchWrap}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={t.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input placeholder="Filter…" value={filter} onChange={e => setFilter(e.target.value)} style={s.searchInput}/>
      </div>

      <div style={s.tree}>
        {groups.map(g => (
          <div key={g.key}>
            <div style={s.groupRow} onClick={() => toggle(g.key)}>
              <Chevron open={expanded[g.key]} color={t.textMuted}/>
              <span style={s.groupLabel}>{g.label}</span>
              <span style={s.groupCount}>{g.count}</span>
            </div>

            {expanded[g.key] && g.key === 'tables' && filteredTables.map(table => (
              <div key={table.name}>
                <div
                  style={{ ...s.tableRow, ...(activeTable === table.name ? s.tableRowActive : {}) }}
                  onClick={() => { onTableSelect(table.name); toggleTable(table.name); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, name: table.name, type: 'table' });
                  }}
                  title={table.comment || undefined}
                >
                  <Chevron open={!!expandedTables[table.name]} color={t.textMuted}/>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={activeTable === table.name ? t.accent : t.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
                    <path d="M3 3h18v5H3zM3 8h18v5H3zM3 13h18v8H3z"/>
                  </svg>
                  <span style={{ ...s.tableName, color: activeTable === table.name ? t.textPrimary : t.textSecondary }}>
                    {table.name}
                  </span>
                  <span style={s.rowCount}>{table.rows.toLocaleString()}</span>
                </div>

                {expandedTables[table.name] && table.columns?.map(col => (
                  <div key={col.name} style={s.colRow} title={col.comment || undefined}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={col.pk ? t.colorInfo : t.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
                      {col.pk
                        ? <><circle cx="12" cy="8" r="4"/><path d="M12 12v8M9 18h6"/></>
                        : <line x1="12" y1="5" x2="12" y2="19"/>}
                    </svg>
                    <span style={s.colName}>{col.name}</span>
                    <span style={s.colType}>{col.type}</span>
                  </div>
                ))}
              </div>
            ))}

            {expanded[g.key] && g.key !== 'tables' && (() => {
              const objType: ObjectType =
                g.key === 'views' ? 'view' :
                g.key === 'procedures' ? 'procedure' :
                'trigger';
              const items: string[] = (
                g.key === 'views' ? schema.views :
                g.key === 'procedures' ? schema.procedures :
                schema.triggers
              ) ?? [];
              const filtered = filter
                ? items.filter(n => n.toLowerCase().includes(filter.toLowerCase()))
                : items;
              if (filtered.length === 0) return <div style={s.emptyGroup}>No {g.label.toLowerCase()}</div>;
              return filtered.map(name => (
                <div
                  key={name}
                  style={{ ...s.tableRow, paddingLeft: 28 }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, name, type: objType });
                  }}
                  onClick={() => setShowSchemaFor({ name, type: objType })}
                  title={name}
                >
                  <span style={{ ...s.tableName, color: t.textSecondary }}>{name}</span>
                </div>
              ));
            })()}
            <div style={s.divLine}/>
          </div>
        ))}
      </div>

      {contextMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 100,
            minWidth: 200, background: t.bgElevated, border: `1px solid ${t.border}`,
            borderRadius: 4, boxShadow: t.shadowMd, padding: 4,
            fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 12,
          }}
        >
          <CtxItem
            t={t}
            onClick={() => { setShowSchemaFor({ name: contextMenu.name, type: contextMenu.type }); setContextMenu(null); }}
            icon={<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>}
            label="Show schema"
          />
          {contextMenu.type === 'table' && (<>
            <div style={{ height: 1, background: t.borderSubtle, margin: '3px 0' }}/>
            <CtxItem
              t={t}
              onClick={() => { setConfirmDrop({ table: contextMenu.name, typedName: '', error: null, working: false }); setContextMenu(null); }}
              icon={<><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M5 6l.7-2.1A2 2 0 0 1 7.6 2h8.8a2 2 0 0 1 1.9 1.9L19 6"/></>}
              label="Drop table"
              color={t.colorError}
            />
          </>)}
        </div>
      )}

      {/* Drop confirm */}
      {confirmDrop && (
        <div
          onClick={() => { if (!confirmDrop.working) setConfirmDrop(null); }}
          style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: t.bgElevated, border: `1px solid ${t.colorErrorBorder}`, borderRadius: 6, padding: 20, minWidth: 440, maxWidth: 560, fontFamily: '"IBM Plex Sans", sans-serif', color: t.textPrimary, boxShadow: '0 10px 40px rgba(0,0,0,0.4)' }}
          >
            <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={t.colorError} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              Drop table?
            </h3>
            <p style={{ margin: '0 0 6px', fontSize: 12, color: t.textSecondary }}>
              This will permanently delete <code style={{ fontFamily: 'monospace', color: t.textPrimary }}>`{confirmDrop.table}`</code> and all its data. This cannot be undone.
            </p>
            <pre style={{ margin: '0 0 14px', padding: '7px 10px', background: t.bgBase, border: `1px solid ${t.borderSubtle}`, borderRadius: 4, fontSize: 11, fontFamily: '"JetBrains Mono", monospace', color: t.textPrimary }}>
              {`DROP TABLE \`${confirmDrop.table}\``}
            </pre>
            <label style={{ display: 'block', fontSize: 11, color: t.textMuted, marginBottom: 5 }}>
              Type <strong style={{ color: t.textPrimary, fontFamily: 'monospace' }}>{confirmDrop.table}</strong> to confirm:
            </label>
            <input
              ref={dropInputRef}
              value={confirmDrop.typedName}
              onChange={(e) => setConfirmDrop(p => p ? { ...p, typedName: e.target.value, error: null } : p)}
              onKeyDown={(e) => { if (e.key === 'Escape') setConfirmDrop(null); }}
              disabled={confirmDrop.working}
              placeholder={confirmDrop.table}
              style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', marginBottom: 12, background: t.bgBase, color: t.textPrimary, border: `1px solid ${confirmDrop.error ? t.colorError : t.border}`, borderRadius: 3, outline: 'none', fontSize: 12, fontFamily: 'monospace' }}
            />
            {confirmDrop.error && (
              <div style={{ margin: '-6px 0 12px', padding: '7px 10px', background: t.colorErrorBg, border: `1px solid ${t.colorErrorBorder}`, borderRadius: 4, fontSize: 11, color: t.colorError, fontFamily: 'monospace' }}>
                {confirmDrop.error}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                disabled={confirmDrop.working}
                onClick={() => setConfirmDrop(null)}
                style={{ padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: 'transparent', color: t.textSecondary, border: `1px solid ${t.border}`, borderRadius: 4, cursor: confirmDrop.working ? 'not-allowed' : 'pointer' }}
              >Cancel</button>
              <button
                disabled={confirmDrop.typedName !== confirmDrop.table || confirmDrop.working}
                onClick={async () => {
                  if (confirmDrop.typedName !== confirmDrop.table) return;
                  setConfirmDrop(p => p ? { ...p, working: true, error: null } : p);
                  try {
                    await onDropTable?.(activeSchema, confirmDrop.table);
                    setConfirmDrop(null);
                  } catch (err) {
                    setConfirmDrop(p => p ? { ...p, working: false, error: err instanceof Error ? err.message : String(err) } : p);
                  }
                }}
                style={{ padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: t.colorError, color: '#fff', border: 'none', borderRadius: 4, opacity: (confirmDrop.typedName !== confirmDrop.table || confirmDrop.working) ? 0.4 : 1, cursor: (confirmDrop.typedName !== confirmDrop.table || confirmDrop.working) ? 'not-allowed' : 'pointer' }}
              >{confirmDrop.working ? 'Dropping…' : 'Drop Table'}</button>
            </div>
          </div>
        </div>
      )}

      {showSchemaFor && (
        <ShowSchemaDialog
          schema={activeSchema}
          name={showSchemaFor.name}
          type={showSchemaFor.type}
          onClose={() => setShowSchemaFor(null)}
          t={t}
        />
      )}
    </div>
  );
}

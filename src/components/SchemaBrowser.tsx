import { useState, CSSProperties } from 'react';
import type { Theme } from '../theme';

interface Column {
  name: string;
  type: string;
  pk?: boolean;
}

interface Table {
  name: string;
  rows: number | string;
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
  t: Theme;
}

const Chevron = ({ open, color }: { open: boolean; color: string }) => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    {open ? <polyline points="6 9 12 15 18 9"/> : <polyline points="9 18 15 12 9 6"/>}
  </svg>
);

export function SchemaBrowser({ schema, activeTable, onTableSelect, onSchemaChange, schemas, activeSchema, t }: SchemaBrowserProps) {
  const [expanded, setExpanded] = useState({ tables: true, views: false, procedures: false, triggers: false });
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');

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
                  <div key={col.name} style={s.colRow}>
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

            {expanded[g.key] && g.key !== 'tables' && (
              <div style={s.emptyGroup}>No {g.label.toLowerCase()}</div>
            )}
            <div style={s.divLine}/>
          </div>
        ))}
      </div>
    </div>
  );
}

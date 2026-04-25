import { useState, useEffect, useRef, CSSProperties, MutableRefObject } from 'react';
import type { Theme } from '../theme';
import type { ColumnMeta, SchemaData } from '../api';
import { InsertRowDialog } from './InsertRowDialog';
import { rowsToCsv, rowsToJson, downloadBlob, sanitizeFilename } from '../export';

export interface QueryResults {
  columns: string[];
  columnMeta?: ColumnMeta[];
  rows: Record<string, string | number | null>[];
}

type Row = Record<string, string | number | null>;
type CellValue = string | number | boolean | null;

interface DeleteTarget {
  table: string;
  where: { column: string; value: CellValue }[];
}

export interface UpdateCellTarget {
  table: string;
  where: { column: string; value: CellValue }[];
  column: string;
  value: CellValue;
}

type EditKind = 'boolean' | 'number' | 'date' | 'datetime' | 'time' | 'text';

function editKindForType(type: number): EditKind {
  // MySQL column type codes
  switch (type) {
    case 1: case 2: case 3: case 4: case 5: case 8: case 9: case 13: case 246:
      return 'number'; // TINYINT, SMALLINT, INT, FLOAT, DOUBLE, BIGINT, MEDIUMINT, YEAR, NEWDECIMAL
    case 10: case 14:
      return 'date';
    case 7: case 12: case 17: case 18:
      return 'datetime'; // TIMESTAMP, DATETIME
    case 11: case 19:
      return 'time';
    default:
      return 'text';
  }
}

// MySQL datetime looks like "YYYY-MM-DD HH:MM:SS"; <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM".
function toDatetimeLocal(v: CellValue): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.replace(' ', 'T').slice(0, 16);
}
function fromDatetimeLocal(v: string): string {
  return v.replace('T', ' ');
}

interface ResultsTableProps {
  results: QueryResults | null;
  isRunning: boolean;
  error: string | null;
  executionTime: number | null;
  activeSchema?: string;
  schemaData?: SchemaData;
  onDeleteRow?: (row: Row, target: DeleteTarget) => Promise<void> | void;
  onUpdateCell?: (row: Row, target: UpdateCellTarget) => Promise<void> | void;
  onInsertRow?: (table: string, values: Record<string, CellValue>) => Promise<void> | void;
  t: Theme;
}

function commentFor(schemaData: SchemaData | undefined, meta: ColumnMeta | undefined): string | undefined {
  if (!schemaData || !meta?.orgTable || !meta.orgName) return undefined;
  const table = schemaData.tables.find(x => x.name === meta.orgTable);
  const col = table?.columns.find(c => c.name === meta.orgName);
  return col?.comment || undefined;
}

function isBoolColumn(schemaData: SchemaData | undefined, meta: ColumnMeta | undefined): boolean {
  if (!schemaData || !meta?.orgTable || !meta.orgName) return false;
  const table = schemaData.tables.find(x => x.name === meta.orgTable);
  const col = table?.columns.find(c => c.name === meta.orgName);
  return col?.type === 'tinyint(1)';
}

function cellDisplayValue(val: string | number | boolean | null, meta: ColumnMeta | undefined, schemaData: SchemaData | undefined): string {
  if (val === null) return '';
  if (isBoolColumn(schemaData, meta)) return val === 1 || val === true ? 'true' : 'false';
  return String(val);
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

interface Deletability {
  target: DeleteTarget | null;
  reason: string | null;
}

function resolveDeleteTarget(row: Row, columnMeta: ColumnMeta[] | undefined): Deletability {
  if (!columnMeta || columnMeta.length === 0) {
    return { target: null, reason: 'No column metadata available.' };
  }

  const pkCols = columnMeta.filter(c => c.pk && c.orgTable && c.orgName);
  if (pkCols.length > 0) {
    const table = pkCols[0].orgTable;
    if (pkCols.some(c => c.orgTable !== table)) {
      return { target: null, reason: 'Primary-key columns span multiple tables.' };
    }
    const where = pkCols.map(c => ({ column: c.orgName, value: row[c.name] ?? null }));
    if (where.some(w => w.value === null)) {
      return { target: null, reason: 'Primary-key column is NULL in this row.' };
    }
    return { target: { table, where }, reason: null };
  }

  const uniqueCol = columnMeta.find(c => c.unique && c.orgTable && c.orgName);
  if (uniqueCol) {
    const value = row[uniqueCol.name] ?? null;
    if (value === null) {
      return { target: null, reason: `Unique column \`${uniqueCol.orgName}\` is NULL in this row.` };
    }
    return {
      target: { table: uniqueCol.orgTable, where: [{ column: uniqueCol.orgName, value }] },
      reason: null,
    };
  }

  return {
    target: null,
    reason: 'No primary or unique key column in the result set. Re-run the query including a key column, or disable SQL_SAFE_UPDATES to delete without one.',
  };
}

export function ResultsTable({ results, isRunning, error, executionTime, activeSchema, schemaData, onDeleteRow, onUpdateCell, onInsertRow, t }: ResultsTableProps) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: Row; col: string | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ row: Row; target: DeleteTarget } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [editing, setEditing] = useState<{ row: Row; col: string; draft: string; kind: EditKind; nullable: boolean; saving: boolean; error: string | null } | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState<{ row: Row; target: UpdateCellTarget; error: string | null; saving: boolean } | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [selectedCol, setSelectedCol] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  // Column layout: order and widths
  const [colOrder, setColOrder] = useState<string[]>([]);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [dragSrc, setDragSrc] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);
  // Refs so event-handler closures always see the latest values
  const colWidthsRef = useRef(colWidths);
  const colOrderRef  = useRef(colOrder);
  useEffect(() => { colWidthsRef.current = colWidths; }, [colWidths]);
  useEffect(() => { colOrderRef.current  = colOrder;  }, [colOrder]);

  useEffect(() => {
    if (!exportOpen) return;
    const close = () => setExportOpen(false);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', key);
    };
  }, [exportOpen]);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editing?.row, editing?.col]);

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

  // Ctrl+F opens the filter bar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setFilterOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (filterOpen) { filterInputRef.current?.focus(); filterInputRef.current?.select(); }
  }, [filterOpen]);

  // Persist layout only when the result comes from a single identifiable table
  const persistKey = (() => {
    if (!activeSchema || !results?.columnMeta?.length) return null;
    const tables = new Set(results.columnMeta.map(c => c.orgTable).filter(Boolean));
    if (tables.size !== 1) return null;
    return `helix.grid-layout.${activeSchema}.${[...tables][0]}`;
  })();

  const saveLayout = (order: string[], widths: Record<string, number>) => {
    if (!persistKey) return;
    try { localStorage.setItem(persistKey, JSON.stringify({ order, widths })); } catch {}
  };

  // Sync column order/widths when the result set changes
  useEffect(() => {
    if (!results) { setColOrder([]); setColWidths({}); return; }
    const cols = results.columns;
    let order = cols;
    let widths: Record<string, number> = {};
    if (persistKey) {
      try {
        const raw = localStorage.getItem(persistKey);
        if (raw) {
          const saved = JSON.parse(raw) as { order?: string[]; widths?: Record<string, number> };
          if (saved.order) {
            const inResult = new Set(cols);
            const known = saved.order.filter(c => inResult.has(c));
            const novel = cols.filter(c => !saved.order!.includes(c));
            order = [...known, ...novel];
          }
          if (saved.widths) widths = saved.widths;
        }
      } catch {}
    }
    setColOrder(order);
    setColWidths(widths);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, persistKey]);

  useEffect(() => { setSelectedRow(null); setSelectedCol(null); }, [results]);
  useEffect(() => {
    if (selectedRow !== null) rowRefs.current[selectedRow]?.scrollIntoView({ block: 'nearest' });
  }, [selectedRow]);

  // Global cursor override while resizing
  useEffect(() => {
    if (!resizingCol) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => { document.body.style.cursor = prev; document.body.style.userSelect = ''; };
  }, [resizingCol]);

  // Columns in their current display order
  const displayCols = (() => {
    const cols = results?.columns ?? [];
    if (colOrder.length === 0) return cols;
    const set = new Set(cols);
    const known = colOrder.filter(c => set.has(c));
    const novel = cols.filter(c => !new Set(known).has(c));
    return [...known, ...novel];
  })();

  const s = {
    root: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: t.bgBase } as CSSProperties,
    center: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 } as CSSProperties,
    tabBar: { display: 'flex', alignItems: 'stretch', borderBottom: `1px solid ${t.border}`, background: t.bgToolbar, flexShrink: 0, height: 32 } as CSSProperties,
    tabActive: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px', fontSize: 12, color: t.textPrimary, borderBottom: `2px solid ${t.accent}`, cursor: 'pointer', fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
    tabInactive: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px', fontSize: 12, color: t.textMuted, cursor: 'pointer', fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
    exportBtn: { display: 'flex', alignItems: 'center', gap: 5, margin: '5px 10px', padding: '0 10px', background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 4, fontSize: 11, color: t.textSecondary, cursor: 'pointer', fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
    tableWrap: { flex: 1, overflow: 'auto' } as CSSProperties,
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } as CSSProperties,
    th: { background: t.bgSurface, padding: '7px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: t.textMuted, borderBottom: `1px solid ${t.border}`, whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none', position: 'sticky', top: 0, zIndex: 1 } as CSSProperties,
    tr: { borderBottom: `1px solid ${t.borderSubtle}`, transition: 'background 100ms ease', cursor: 'pointer' } as CSSProperties,
    td: { padding: '6px 12px', fontFamily: '"JetBrains Mono", monospace', fontSize: 12, whiteSpace: 'nowrap', color: t.textPrimary } as CSSProperties,
    statusBar: { display: 'flex', alignItems: 'center', gap: 10, padding: '5px 14px', borderTop: `1px solid ${t.borderSubtle}`, background: t.bgToolbar, flexShrink: 0 } as CSSProperties,
    stat: { fontSize: 11, color: t.textMuted, fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
    statDiv: { width: 1, height: 12, background: t.border } as CSSProperties,
  };

  const handleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const cellStyle = (val: string | number | null): CSSProperties => {
    if (val === null) return { ...s.td, color: t.textMuted, fontStyle: 'italic' };
    if (typeof val === 'number') return { ...s.td, color: t.sqlNumber };
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) return { ...s.td, color: t.sqlString };
    return s.td;
  };

  if (isRunning) return (
    <div style={{ ...s.root, ...s.center }}>
      <div style={{ width: 20, height: 20, border: `2px solid ${t.spinnerTrack}`, borderTop: `2px solid ${t.spinnerHead}`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }}/>
      <span style={{ fontSize: 12, color: t.textMuted }}>Executing query…</span>
    </div>
  );

  if (error) return (
    <div style={{ ...s.root, display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', background: t.colorErrorBg, borderTop: `1px solid ${t.colorErrorBorder}` }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={t.colorError} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span style={{ fontSize: 12, color: t.colorError, fontFamily: 'monospace' }}>{error}</span>
    </div>
  );

  if (!results) return (
    <div style={{ ...s.root, ...s.center }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={t.border} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      <span style={{ fontSize: 12, color: t.textMuted }}>Run a query to see results</span>
    </div>
  );

  const { columns, rows } = results;
  const sorted = [...rows].sort((a, b) => {
    if (!sortCol) return 0;
    const av = a[sortCol], bv = b[sortCol];
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const needle = filterText.toLowerCase();
  const filtered = needle
    ? sorted.filter(row => displayCols.some(col => {
        const v = row[col];
        return v !== null && String(v).toLowerCase().includes(needle);
      }))
    : sorted;

  const LARGE_ROW_THRESHOLD = 5_000;

  const formatExecTime = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;

  const exportBaseName = (() => {
    if (!results?.columnMeta) return 'results';
    const orgTables = new Set(results.columnMeta.map(c => c.orgTable).filter(Boolean));
    return orgTables.size === 1 ? sanitizeFilename([...orgTables][0]) : 'results';
  })();

  const exportAs = (format: 'csv' | 'json') => {
    if (!results) return;
    const content = format === 'csv'
      ? rowsToCsv(results.columns, sorted)
      : rowsToJson(sorted);
    const mime = format === 'csv' ? 'text/csv' : 'application/json';
    downloadBlob(content, mime, `${exportBaseName}.${format}`);
    setExportOpen(false);
  };

  // Determine if the current result set maps to a single source table so we can offer "New row"
  const insertTarget = (() => {
    if (!results?.columnMeta || results.columnMeta.length === 0) return null;
    const orgTables = new Set(results.columnMeta.map(c => c.orgTable).filter(Boolean));
    if (orgTables.size !== 1) return null;
    const table = [...orgTables][0];
    const def = schemaData?.tables.find(x => x.name === table);
    if (!def) return null;
    return { table, columns: def.columns };
  })();

  return (
    <div style={s.root}>
      <div style={s.tabBar}>
        <div style={s.tabActive}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3h18v5H3zM3 8h18v5H3zM3 13h18v8H3z"/>
          </svg>
          Result 1
        </div>
        <div style={s.tabInactive}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Output
        </div>
        <div style={{ flex: 1 }}/>
        <button
          style={{ ...s.exportBtn, background: filterOpen ? t.bgHover : t.bgElevated }}
          onClick={() => { if (filterOpen) { setFilterOpen(false); setFilterText(''); } else setFilterOpen(true); }}
          title="Filter rows (Ctrl+F)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Filter
        </button>
        {onInsertRow && insertTarget && (
          <button
            style={s.exportBtn}
            onClick={() => setInsertOpen(true)}
            title={`Insert a new row into ${insertTarget.table}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New row
          </button>
        )}
        <div style={{ position: 'relative' }}>
          <button
            style={{ ...s.exportBtn, opacity: results ? 1 : 0.5, cursor: results ? 'pointer' : 'not-allowed' }}
            onClick={(e) => { e.stopPropagation(); if (results) setExportOpen(o => !o); }}
            disabled={!results}
            title={results ? 'Export current results' : 'Run a query first'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2 }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {exportOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 100,
                minWidth: 180, background: t.bgElevated, border: `1px solid ${t.border}`,
                borderRadius: 4, boxShadow: t.shadowMd, padding: 4,
                fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 12,
              }}
            >
              <ExportMenuItem t={t} label="CSV" hint={`${exportBaseName}.csv`} onClick={() => exportAs('csv')} />
              <ExportMenuItem t={t} label="JSON" hint={`${exportBaseName}.json`} onClick={() => exportAs('json')} />
            </div>
          )}
        </div>
      </div>

      {rows.length > LARGE_ROW_THRESHOLD && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px',
          background: t.colorWarningBg, borderBottom: `1px solid ${t.colorWarning}40`,
          flexShrink: 0,
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={t.colorWarning} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span style={{ fontSize: 11, color: t.colorWarning, fontFamily: '"IBM Plex Sans", sans-serif' }}>
            <strong>{rows.length.toLocaleString()}</strong> rows returned — consider adding a <code style={{ fontFamily: 'monospace' }}>LIMIT</code> to your query to avoid loading large result sets.
          </span>
        </div>
      )}

      {filterOpen && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
          background: t.bgSurface, borderBottom: `1px solid ${t.border}`, flexShrink: 0,
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={t.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={filterInputRef}
            type="text"
            placeholder="Filter rows…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setFilterOpen(false); setFilterText(''); } }}
            style={{
              flex: 1, maxWidth: 280, padding: '3px 8px', fontSize: 12,
              background: t.bgBase, color: t.textPrimary,
              border: `1px solid ${t.border}`, borderRadius: 3, outline: 'none',
              fontFamily: '"IBM Plex Sans", sans-serif',
            }}
          />
          {needle && (
            <span style={{ ...s.stat, color: filtered.length === 0 ? t.colorError : t.textMuted }}>
              {filtered.length} of {rows.length}
            </span>
          )}
          <button
            onClick={() => { setFilterOpen(false); setFilterText(''); }}
            title="Close filter (Esc)"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 20, height: 20, padding: 0, border: 'none',
              background: 'transparent', color: t.textMuted, cursor: 'pointer',
              borderRadius: 3, fontSize: 14, lineHeight: 1,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = t.bgHover; e.currentTarget.style.color = t.textPrimary; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = t.textMuted; }}
          >×</button>
        </div>
      )}

      <div
        ref={tableWrapRef}
        tabIndex={0}
        style={{ ...s.tableWrap, outline: 'none' }}
        onKeyDown={(e) => {
          if (editing || confirmDelete || confirmUpdate) return;
          const rowCount = filtered.length;
          const colCount = displayCols.length;
          if (!rowCount) return;
          switch (e.key) {
            case 'ArrowDown': {
              e.preventDefault();
              setSelectedRow(prev => Math.min(prev === null ? 0 : prev + 1, rowCount - 1));
              if (selectedCol === null) setSelectedCol(0);
              break;
            }
            case 'ArrowUp': {
              e.preventDefault();
              setSelectedRow(prev => Math.max(prev === null ? 0 : prev - 1, 0));
              if (selectedCol === null) setSelectedCol(0);
              break;
            }
            case 'ArrowRight': {
              e.preventDefault();
              if (selectedRow === null) { setSelectedRow(0); setSelectedCol(0); break; }
              setSelectedCol(prev => Math.min(prev === null ? 0 : prev + 1, colCount - 1));
              break;
            }
            case 'ArrowLeft': {
              e.preventDefault();
              if (selectedRow === null) { setSelectedRow(0); setSelectedCol(0); break; }
              setSelectedCol(prev => Math.max(prev === null ? 0 : prev - 1, 0));
              break;
            }
            case 'Home': {
              e.preventDefault();
              if (selectedRow === null) break;
              setSelectedCol(0);
              break;
            }
            case 'End': {
              e.preventDefault();
              if (selectedRow === null) break;
              setSelectedCol(colCount - 1);
              break;
            }
            case 'PageUp': {
              e.preventDefault();
              const wrap = tableWrapRef.current;
              if (!wrap) break;
              const page = Math.max(1, Math.floor(wrap.clientHeight / (wrap.scrollHeight / rowCount)));
              setSelectedRow(prev => Math.max(0, (prev ?? 0) - page));
              if (selectedCol === null) setSelectedCol(0);
              break;
            }
            case 'PageDown': {
              e.preventDefault();
              const wrap = tableWrapRef.current;
              if (!wrap) break;
              const page = Math.max(1, Math.floor(wrap.clientHeight / (wrap.scrollHeight / rowCount)));
              setSelectedRow(prev => Math.min(rowCount - 1, (prev ?? 0) + page));
              if (selectedCol === null) setSelectedCol(0);
              break;
            }
            case 'Enter': {
              if (selectedRow === null || selectedCol === null) break;
              const row = filtered[selectedRow];
              const col = displayCols[selectedCol];
              const meta = results.columnMeta?.find(m => m.name === col);
              const editable = !!(onUpdateCell && meta && meta.orgTable && meta.orgName && !meta.pk);
              if (!editable || !meta) break;
              e.preventDefault();
              const kind = isBoolColumn(schemaData, meta) ? 'boolean' : editKindForType(meta.mysqlType);
              const nullable = !meta.notNull;
              const current = row[col];
              const draft = kind === 'boolean'
                ? (current === null || current === undefined ? 'null' : current === 1 || current === true ? 'true' : 'false')
                : current === null || current === undefined ? ''
                : kind === 'datetime' ? toDatetimeLocal(current)
                : kind === 'date' ? String(current).slice(0, 10)
                : kind === 'time' ? String(current).slice(-8)
                : String(current);
              setEditing({ row, col, draft, kind, nullable, saving: false, error: null });
              break;
            }
            case 'Escape': {
              setSelectedRow(null);
              setSelectedCol(null);
              break;
            }
            case 'c': {
              if (!(e.ctrlKey || e.metaKey)) break;
              if (selectedRow === null) break;
              e.preventDefault();
              const row = filtered[selectedRow];
              if (selectedCol !== null) {
                const col = displayCols[selectedCol];
                const meta = results.columnMeta?.find(m => m.name === col);
                copyToClipboard(cellDisplayValue(row[col] ?? null, meta, schemaData));
              } else {
                const text = displayCols.map(col => {
                  const meta = results.columnMeta?.find(m => m.name === col);
                  return cellDisplayValue(row[col] ?? null, meta, schemaData);
                }).join('\t');
                copyToClipboard(text);
              }
              break;
            }
          }
        }}
      >
        <table style={s.table}>
          <thead>
            <tr>
              <th style={{ ...s.th, width: 40, textAlign: 'right', paddingRight: 10, cursor: 'default' }}>#</th>
              {displayCols.map(col => {
                const hMeta = results.columnMeta?.find(m => m.name === col);
                const hComment = commentFor(schemaData, hMeta);
                const w = colWidths[col];
                const isDragSrc  = dragSrc  === col;
                const isDragOver = dragOver === col && dragSrc !== col;
                return (
                  <th
                    key={col}
                    draggable
                    onDragStart={(e) => {
                      if (resizeRef.current) { e.preventDefault(); return; }
                      setDragSrc(col);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', col);
                    }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(col); }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const src = e.dataTransfer.getData('text/plain');
                      setDragSrc(null); setDragOver(null);
                      if (!src || src === col) return;
                      setColOrder(prev => {
                        const next = [...prev.length ? prev : (results?.columns ?? [])];
                        const si = next.indexOf(src), di = next.indexOf(col);
                        if (si === -1 || di === -1) return prev;
                        next.splice(si, 1); next.splice(di, 0, src);
                        setTimeout(() => saveLayout(next, colWidthsRef.current), 0);
                        return next;
                      });
                    }}
                    onDragEnd={() => { setDragSrc(null); setDragOver(null); }}
                    onClick={() => { if (!resizeRef.current) handleSort(col); }}
                    title={hComment}
                    style={{
                      ...s.th,
                      position: 'relative',
                      cursor: resizingCol ? 'col-resize' : 'grab',
                      overflow: 'hidden',
                      ...(w ? { width: w, minWidth: w } : { minWidth: 80 }),
                      ...(col === sortCol ? { color: t.accent } : {}),
                      ...(isDragOver ? { boxShadow: `inset 2px 0 0 ${t.accent}` } : {}),
                      ...(isDragSrc  ? { opacity: 0.4 } : {}),
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden', paddingRight: 4 }}>
                      {col}
                      {sortCol === col && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          {sortDir === 'asc' ? <polyline points="18 15 12 9 6 15"/> : <polyline points="6 9 12 15 18 9"/>}
                        </svg>
                      )}
                    </div>
                    {/* Resize handle */}
                    <div
                      onMouseDown={(e) => {
                        e.preventDefault(); e.stopPropagation();
                        const th = (e.currentTarget as HTMLElement).closest('th') as HTMLTableCellElement;
                        const startWidth = th.getBoundingClientRect().width;
                        resizeRef.current = { col, startX: e.clientX, startWidth };
                        setResizingCol(col);
                        const onMove = (ev: MouseEvent) => {
                          if (!resizeRef.current) return;
                          const newW = Math.max(60, resizeRef.current.startWidth + ev.clientX - resizeRef.current.startX);
                          setColWidths(prev => ({ ...prev, [resizeRef.current!.col]: newW }));
                        };
                        const onUp = () => {
                          resizeRef.current = null; setResizingCol(null);
                          saveLayout(colOrderRef.current, colWidthsRef.current);
                          document.removeEventListener('mousemove', onMove);
                          document.removeEventListener('mouseup', onUp);
                        };
                        document.addEventListener('mousemove', onMove);
                        document.addEventListener('mouseup', onUp);
                      }}
                      style={{
                        position: 'absolute', right: 0, top: 0, bottom: 0, width: 5,
                        cursor: 'col-resize', zIndex: 2,
                        background: resizingCol === col ? t.accent : 'transparent',
                      }}
                      onMouseEnter={e => { if (!resizingCol) (e.currentTarget as HTMLElement).style.background = t.borderStrong; }}
                      onMouseLeave={e => { if (!resizingCol) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, i) => (
              <tr
                key={i}
                ref={(el) => { rowRefs.current[i] = el; }}
                style={{ ...s.tr, background: selectedRow === i ? t.bgSelected : i % 2 === 0 ? 'transparent' : t.bgHover }}
                onClick={() => { setSelectedRow(i); setSelectedCol(null); tableWrapRef.current?.focus(); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelectedRow(i);
                  setSelectedCol(null);
                  setContextMenu({ x: e.clientX, y: e.clientY, row, col: null });
                }}
              >
                <td style={{ ...s.td, color: t.textMuted, textAlign: 'right', paddingRight: 10, fontSize: 10, fontFamily: 'monospace' }}>{i + 1}</td>
                {displayCols.map((col, colIdx) => {
                  const meta = results.columnMeta?.find(m => m.name === col);
                  const isEditing = editing && editing.row === row && editing.col === col;
                  const editable = !!(onUpdateCell && meta && meta.orgTable && meta.orgName && !meta.pk);
                  const isFocusedCell = selectedRow === i && selectedCol === colIdx && !isEditing;
                  return (
                    <td
                      key={col}
                      onClick={(e) => { e.stopPropagation(); setSelectedRow(i); setSelectedCol(colIdx); tableWrapRef.current?.focus(); }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedRow(i);
                        setSelectedCol(colIdx);
                        setContextMenu({ x: e.clientX, y: e.clientY, row, col });
                      }}
                      style={{
                        ...cellStyle(row[col] ?? null),
                        padding: isEditing ? 0 : undefined,
                        ...(isFocusedCell ? { boxShadow: `inset 0 0 0 2px ${t.accent}` } : {}),
                      }}
                      onDoubleClick={(e) => {
                        if (!editable || !meta) return;
                        e.stopPropagation();
                        const kind = isBoolColumn(schemaData, meta) ? 'boolean' : editKindForType(meta.mysqlType);
                        const nullable = !meta.notNull;
                        const current = row[col];
                        const draft = kind === 'boolean'
                          ? (current === null || current === undefined ? 'null' : current === 1 || current === true ? 'true' : 'false')
                          : current === null || current === undefined ? ''
                          : kind === 'datetime' ? toDatetimeLocal(current)
                          : kind === 'date' ? String(current).slice(0, 10)
                          : kind === 'time' ? String(current).slice(-8)
                          : String(current);
                        setEditing({ row, col, draft, kind, nullable, saving: false, error: null });
                      }}
                      title={(() => {
                        const comment = commentFor(schemaData, meta);
                        const hint = editable ? 'Double-click to edit' : meta?.pk ? 'Primary key — not editable' : undefined;
                        return [comment, hint].filter(Boolean).join(' — ') || undefined;
                      })()}
                    >
                      {isEditing ? (
                        <CellEditor
                          t={t}
                          kind={editing!.kind}
                          nullable={editing!.nullable}
                          draft={editing!.draft}
                          saving={editing!.saving || !!confirmUpdate}
                          error={editing!.error}
                          suspended={!!confirmUpdate}
                          inputRef={editInputRef}
                          onChange={(v) => setEditing(prev => prev ? { ...prev, draft: v } : prev)}
                          onCancel={() => setEditing(null)}
                          onCommit={() => {
                            if (!editing || !onUpdateCell) return;
                            const del = resolveDeleteTarget(editing.row, results.columnMeta);
                            if (!del.target) {
                              setEditing(prev => prev ? { ...prev, error: del.reason } : prev);
                              return;
                            }
                            const editedMeta = results.columnMeta?.find(m => m.name === editing.col);
                            if (!editedMeta || editedMeta.orgTable !== del.target.table) {
                              setEditing(prev => prev ? { ...prev, error: 'Column does not belong to the same table as the key.' } : prev);
                              return;
                            }
                            const raw = editing.draft;
                            let value: CellValue;
                            if (editing.kind === 'boolean') value = raw === 'null' ? null : raw === 'true';
                            else if (raw === '' && !editedMeta.notNull) value = null;
                            else if (editing.kind === 'number') value = raw === '' ? '' : Number(raw);
                            else if (editing.kind === 'datetime') value = raw === '' ? null : fromDatetimeLocal(raw);
                            else value = raw;

                            const currentVal = editing.row[editing.col] ?? null;
                            const normBool = (v: CellValue) => v === null ? null : (v === 1 || v === true);
                            const unchanged = editing.kind === 'boolean'
                              ? normBool(value) === normBool(currentVal)
                              : value === currentVal;
                            if (unchanged) { setEditing(null); return; }

                            setConfirmUpdate({
                              row: editing.row,
                              target: { table: del.target.table, where: del.target.where, column: editedMeta.orgName, value },
                              error: null,
                              saving: false,
                            });
                          }}
                        />
                      ) : (
                        row[col] === null
                          ? <em>NULL</em>
                          : isBoolColumn(schemaData, meta)
                            ? (row[col] === 1 || row[col] === true ? 'true' : 'false')
                            : String(row[col])
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={s.statusBar}>
        <span style={s.stat}>
          {needle
            ? <><strong style={{ color: t.textSecondary }}>{filtered.length.toLocaleString()}</strong> of <strong style={{ color: t.textSecondary }}>{rows.length.toLocaleString()}</strong> rows</>
            : <><strong style={{ color: t.textSecondary }}>{rows.length.toLocaleString()}</strong> rows returned</>
          }
        </span>
        <span style={s.statDiv}/>
        <span style={s.stat}><strong style={{ color: t.textSecondary }}>{executionTime !== null ? formatExecTime(executionTime) : '—'}</strong></span>
        <span style={s.statDiv}/>
        <span style={s.stat}><strong style={{ color: t.textSecondary }}>{columns.length}</strong> columns</span>
        {selectedRow !== null && <>
          <span style={s.statDiv}/>
          <span style={{ ...s.stat, color: t.accent }}>
            Row {selectedRow + 1}{selectedCol !== null ? ` · ${displayCols[selectedCol]}` : ''}
          </span>
        </>}
      </div>

      {contextMenu && (() => {
        const { target, reason } = resolveDeleteTarget(contextMenu.row, results.columnMeta);
        const menuItemStyle: CSSProperties = {
          width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none',
          background: 'transparent', color: t.textPrimary,
          cursor: 'pointer', borderRadius: 3, fontSize: 12, fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        };
        return (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 100,
              minWidth: 220, maxWidth: 320, background: t.bgElevated, border: `1px solid ${t.border}`,
              borderRadius: 4, boxShadow: t.shadowMd,
              padding: 4, fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 12,
            }}
          >
            {contextMenu.col !== null && (
              <button
                style={menuItemStyle}
                onClick={() => {
                  const meta = results.columnMeta?.find(m => m.name === contextMenu.col);
                  copyToClipboard(cellDisplayValue(contextMenu.row[contextMenu.col!] ?? null, meta, schemaData));
                  setContextMenu(null);
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = t.bgHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span>Copy cell</span>
                <span style={{ fontSize: 10, color: t.textMuted }}>Ctrl+C</span>
              </button>
            )}
            <button
              style={menuItemStyle}
              onClick={() => {
                const text = displayCols.map(col => {
                  const meta = results.columnMeta?.find(m => m.name === col);
                  return cellDisplayValue(contextMenu.row[col] ?? null, meta, schemaData);
                }).join('\t');
                copyToClipboard(text);
                setContextMenu(null);
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span>Copy row</span>
              {contextMenu.col === null && <span style={{ fontSize: 10, color: t.textMuted }}>Ctrl+C</span>}
            </button>
            <div style={{ height: 1, background: t.borderSubtle, margin: '4px 0' }} />
            <button
              disabled={!target}
              onClick={() => {
                if (!target) return;
                setConfirmDelete({ row: contextMenu.row, target });
                setContextMenu(null);
                setDeleteError(null);
              }}
              style={{
                width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none',
                background: 'transparent', color: target ? t.colorError : t.textMuted,
                cursor: target ? 'pointer' : 'not-allowed', borderRadius: 3, fontSize: 12,
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { if (target) e.currentTarget.style.background = t.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              Delete row
            </button>
            {reason && (
              <div style={{
                padding: '6px 10px 4px', fontSize: 11, color: t.textMuted,
                lineHeight: 1.35, borderTop: `1px solid ${t.borderSubtle}`, marginTop: 2,
              }}>
                {reason}
              </div>
            )}
          </div>
        );
      })()}

      {confirmDelete && (
        <div
          onClick={() => !deleting && setConfirmDelete(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 6,
              padding: 20, minWidth: 420, maxWidth: 600,
              fontFamily: '"IBM Plex Sans", sans-serif', color: t.textPrimary,
              boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
            }}
          >
            <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 600 }}>Delete row?</h3>
            <p style={{ margin: '0 0 12px', fontSize: 12, color: t.textSecondary }}>
              This will run:
            </p>
            <pre style={{
              margin: '0 0 14px', padding: '8px 10px', background: t.bgBase,
              border: `1px solid ${t.borderSubtle}`, borderRadius: 4, fontSize: 11,
              fontFamily: '"JetBrains Mono", monospace', color: t.textPrimary,
              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
{`DELETE FROM \`${confirmDelete.target.table}\`\nWHERE ${confirmDelete.target.where.map(w => `\`${w.column}\` = ${JSON.stringify(w.value)}`).join(' AND ')}\nLIMIT 1;`}
            </pre>
            {deleteError && (
              <div style={{
                margin: '0 0 12px', padding: '8px 10px', background: t.colorErrorBg,
                border: `1px solid ${t.colorErrorBorder}`, borderRadius: 4, fontSize: 11,
                color: t.colorError, fontFamily: 'monospace',
              }}>{deleteError}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                style={{
                  padding: '6px 14px', fontSize: 12, fontFamily: 'inherit',
                  background: 'transparent', color: t.textSecondary,
                  border: `1px solid ${t.border}`, borderRadius: 4,
                  cursor: deleting ? 'not-allowed' : 'pointer',
                }}
              >Cancel</button>
              <button
                onClick={async () => {
                  if (!onDeleteRow) { setConfirmDelete(null); return; }
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    await onDeleteRow(confirmDelete.row, confirmDelete.target);
                    setConfirmDelete(null);
                    setSelectedRow(null);
                  } catch (err) {
                    setDeleteError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setDeleting(false);
                  }
                }}
                disabled={deleting}
                style={{
                  padding: '6px 14px', fontSize: 12, fontFamily: 'inherit',
                  background: t.colorError, color: '#fff', border: 'none', borderRadius: 4,
                  cursor: deleting ? 'wait' : 'pointer', opacity: deleting ? 0.7 : 1,
                }}
              >{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {confirmUpdate && (
        <div
          onClick={() => !confirmUpdate.saving && setConfirmUpdate(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 6,
              padding: 20, minWidth: 460, maxWidth: 640,
              fontFamily: '"IBM Plex Sans", sans-serif', color: t.textPrimary,
              boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
            }}
          >
            <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 600 }}>Update cell?</h3>
            <p style={{ margin: '0 0 12px', fontSize: 12, color: t.textSecondary }}>This will run:</p>
            <pre style={{
              margin: '0 0 14px', padding: '8px 10px', background: t.bgBase,
              border: `1px solid ${t.borderSubtle}`, borderRadius: 4, fontSize: 11,
              fontFamily: '"JetBrains Mono", monospace', color: t.textPrimary,
              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
{`UPDATE \`${confirmUpdate.target.table}\`\nSET \`${confirmUpdate.target.column}\` = ${confirmUpdate.target.value === null ? 'NULL' : JSON.stringify(confirmUpdate.target.value)}\nWHERE ${confirmUpdate.target.where.map(w => `\`${w.column}\` = ${JSON.stringify(w.value)}`).join(' AND ')}\nLIMIT 1;`}
            </pre>
            {confirmUpdate.error && (
              <div style={{
                margin: '0 0 12px', padding: '8px 10px', background: t.colorErrorBg,
                border: `1px solid ${t.colorErrorBorder}`, borderRadius: 4, fontSize: 11,
                color: t.colorError, fontFamily: 'monospace',
              }}>{confirmUpdate.error}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setConfirmUpdate(null)}
                disabled={confirmUpdate.saving}
                style={{
                  padding: '6px 14px', fontSize: 12, fontFamily: 'inherit',
                  background: 'transparent', color: t.textSecondary,
                  border: `1px solid ${t.border}`, borderRadius: 4,
                  cursor: confirmUpdate.saving ? 'not-allowed' : 'pointer',
                }}
              >Cancel</button>
              <button
                onClick={async () => {
                  if (!onUpdateCell) { setConfirmUpdate(null); return; }
                  setConfirmUpdate(prev => prev ? { ...prev, saving: true, error: null } : prev);
                  try {
                    await onUpdateCell(confirmUpdate.row, confirmUpdate.target);
                    setConfirmUpdate(null);
                    setEditing(null);
                  } catch (err) {
                    setConfirmUpdate(prev => prev ? { ...prev, saving: false, error: err instanceof Error ? err.message : String(err) } : prev);
                  }
                }}
                disabled={confirmUpdate.saving}
                style={{
                  padding: '6px 14px', fontSize: 12, fontFamily: 'inherit',
                  background: t.accent, color: '#fff', border: 'none', borderRadius: 4,
                  cursor: confirmUpdate.saving ? 'wait' : 'pointer', opacity: confirmUpdate.saving ? 0.7 : 1,
                }}
              >{confirmUpdate.saving ? 'Updating…' : 'Update'}</button>
            </div>
          </div>
        </div>
      )}

      {insertOpen && insertTarget && onInsertRow && (
        <InsertRowDialog
          table={insertTarget.table}
          columns={insertTarget.columns}
          onClose={() => setInsertOpen(false)}
          onSubmit={async (values) => {
            await onInsertRow(insertTarget.table, values);
            setInsertOpen(false);
          }}
          t={t}
        />
      )}
    </div>
  );
}

function ExportMenuItem({ t, label, hint, onClick }: { t: Theme; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        width: '100%', textAlign: 'left', padding: '6px 10px',
        border: 'none', background: 'transparent', color: t.textPrimary,
        cursor: 'pointer', borderRadius: 3, fontSize: 12, fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = t.bgHover; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 10, color: t.textMuted, fontFamily: 'monospace' }}>{hint}</span>
    </button>
  );
}

interface CellEditorProps {
  t: Theme;
  kind: EditKind;
  nullable?: boolean;
  draft: string;
  saving: boolean;
  error: string | null;
  suspended?: boolean;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function CellEditor({ t, kind, nullable, draft, saving, error, suspended, inputRef, onChange, onCommit, onCancel }: CellEditorProps) {
  const sharedStyle: CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    padding: '6px 12px', margin: 0,
    background: t.bgSurface, color: t.textPrimary,
    border: `1px solid ${error ? t.colorError : t.accent}`,
    outline: 'none', borderRadius: 2,
    fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
  };

  const sharedKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  const errorBubble = error ? (
    <div style={{
      position: 'absolute', top: '100%', left: 0, zIndex: 10,
      marginTop: 2, padding: '4px 8px',
      background: t.colorErrorBg, border: `1px solid ${t.colorErrorBorder}`,
      borderRadius: 3, color: t.colorError, fontSize: 11,
      fontFamily: '"IBM Plex Sans", sans-serif', whiteSpace: 'nowrap',
      boxShadow: t.shadowMd,
    }}>{error}</div>
  ) : null;

  if (kind === 'boolean') {
    return (
      <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <select
          autoFocus
          value={draft}
          disabled={saving}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={sharedKeyDown}
          onBlur={() => { if (!saving && !error && !suspended) onCancel(); }}
          style={sharedStyle}
        >
          {nullable && <option value="null">NULL</option>}
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
        {errorBubble}
      </div>
    );
  }

  const inputType = kind === 'number' ? 'number'
    : kind === 'date' ? 'date'
    : kind === 'datetime' ? 'datetime-local'
    : kind === 'time' ? 'time'
    : 'text';

  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        type={inputType}
        value={draft}
        disabled={saving}
        step={kind === 'number' ? 'any' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={sharedKeyDown}
        onBlur={() => { if (!saving && !error && !suspended) onCancel(); }}
        style={sharedStyle}
      />
      {errorBubble}
    </div>
  );
}

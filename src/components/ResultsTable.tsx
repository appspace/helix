import { useState, useEffect, CSSProperties } from 'react';
import type { Theme } from '../theme';
import type { ColumnMeta } from '../api';

export interface QueryResults {
  columns: string[];
  columnMeta?: ColumnMeta[];
  rows: Record<string, string | number | null>[];
}

type Row = Record<string, string | number | null>;

interface DeleteTarget {
  table: string;
  where: { column: string; value: string | number | null }[];
}

interface ResultsTableProps {
  results: QueryResults | null;
  isRunning: boolean;
  error: string | null;
  executionTime: number | null;
  onDeleteRow?: (row: Row, target: DeleteTarget) => Promise<void> | void;
  t: Theme;
}

function resolveDeleteTarget(row: Row, columnMeta: ColumnMeta[] | undefined): DeleteTarget | null {
  if (!columnMeta || columnMeta.length === 0) return null;
  const pkCols = columnMeta.filter(c => c.pk && c.orgTable && c.orgName);
  if (pkCols.length === 0) return null;
  const table = pkCols[0].orgTable;
  if (pkCols.some(c => c.orgTable !== table)) return null;
  const where = pkCols.map(c => ({ column: c.orgName, value: row[c.name] ?? null }));
  if (where.some(w => w.value === null)) return null;
  return { table, where };
}

export function ResultsTable({ results, isRunning, error, executionTime, onDeleteRow, t }: ResultsTableProps) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ row: Row; target: DeleteTarget } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  const formatExecTime = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;

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
        <button style={s.exportBtn}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Export
        </button>
      </div>

      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={{ ...s.th, width: 40, textAlign: 'right', paddingRight: 10, cursor: 'default' }}>#</th>
              {columns.map(col => (
                <th key={col} style={col === sortCol ? { ...s.th, color: t.accent } : s.th} onClick={() => handleSort(col)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    {col}
                    {sortCol === col && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        {sortDir === 'asc' ? <polyline points="18 15 12 9 6 15"/> : <polyline points="6 9 12 15 18 9"/>}
                      </svg>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr
                key={i}
                style={{ ...s.tr, background: selectedRow === i ? t.bgSelected : i % 2 === 0 ? 'transparent' : t.bgHover }}
                onClick={() => setSelectedRow(i === selectedRow ? null : i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelectedRow(i);
                  setContextMenu({ x: e.clientX, y: e.clientY, row });
                }}
              >
                <td style={{ ...s.td, color: t.textMuted, textAlign: 'right', paddingRight: 10, fontSize: 10, fontFamily: 'monospace' }}>{i + 1}</td>
                {columns.map(col => (
                  <td key={col} style={cellStyle(row[col] ?? null)}>
                    {row[col] === null ? <em>NULL</em> : String(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={s.statusBar}>
        <span style={s.stat}><strong style={{ color: t.textSecondary }}>{rows.length.toLocaleString()}</strong> rows returned</span>
        <span style={s.statDiv}/>
        <span style={s.stat}><strong style={{ color: t.textSecondary }}>{executionTime !== null ? formatExecTime(executionTime) : '—'}</strong></span>
        <span style={s.statDiv}/>
        <span style={s.stat}><strong style={{ color: t.textSecondary }}>{columns.length}</strong> columns</span>
        {selectedRow !== null && <>
          <span style={s.statDiv}/>
          <span style={{ ...s.stat, color: t.accent }}>Row {selectedRow + 1} selected</span>
        </>}
      </div>

      {contextMenu && (() => {
        const target = resolveDeleteTarget(contextMenu.row, results.columnMeta);
        return (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 100,
              minWidth: 180, background: t.bgElevated, border: `1px solid ${t.border}`,
              borderRadius: 4, boxShadow: t.shadowMd,
              padding: 4, fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 12,
            }}
          >
            <button
              disabled={!target}
              onClick={() => {
                if (!target) return;
                setConfirmDelete({ row: contextMenu.row, target });
                setContextMenu(null);
                setDeleteError(null);
              }}
              title={target ? undefined : 'No primary key detected for this row'}
              style={{
                width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none',
                background: 'transparent', color: target ? t.textPrimary : t.textMuted,
                cursor: target ? 'pointer' : 'not-allowed', borderRadius: 3, fontSize: 12,
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { if (target) e.currentTarget.style.background = t.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              Delete row
            </button>
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
    </div>
  );
}

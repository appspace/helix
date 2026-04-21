import { useState, useEffect, useRef, CSSProperties, MutableRefObject } from 'react';
import type { Theme } from '../theme';
import type { ColumnMeta, SchemaData } from '../api';

export interface QueryResults {
  columns: string[];
  columnMeta?: ColumnMeta[];
  rows: Record<string, string | number | null>[];
}

type Row = Record<string, string | number | null>;
type CellValue = string | number | null;

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

type EditKind = 'number' | 'date' | 'datetime' | 'time' | 'text';

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
  schemaData?: SchemaData;
  onDeleteRow?: (row: Row, target: DeleteTarget) => Promise<void> | void;
  onUpdateCell?: (row: Row, target: UpdateCellTarget) => Promise<void> | void;
  t: Theme;
}

function commentFor(schemaData: SchemaData | undefined, meta: ColumnMeta | undefined): string | undefined {
  if (!schemaData || !meta?.orgTable || !meta.orgName) return undefined;
  const table = schemaData.tables.find(x => x.name === meta.orgTable);
  const col = table?.columns.find(c => c.name === meta.orgName);
  return col?.comment || undefined;
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

export function ResultsTable({ results, isRunning, error, executionTime, schemaData, onDeleteRow, onUpdateCell, t }: ResultsTableProps) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ row: Row; target: DeleteTarget } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [editing, setEditing] = useState<{ row: Row; col: string; draft: string; kind: EditKind; saving: boolean; error: string | null } | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState<{ row: Row; target: UpdateCellTarget; error: string | null; saving: boolean } | null>(null);
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
              {columns.map(col => {
                const hMeta = results.columnMeta?.find(m => m.name === col);
                const hComment = commentFor(schemaData, hMeta);
                return (
                <th key={col} style={col === sortCol ? { ...s.th, color: t.accent } : s.th} onClick={() => handleSort(col)} title={hComment}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    {col}
                    {sortCol === col && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        {sortDir === 'asc' ? <polyline points="18 15 12 9 6 15"/> : <polyline points="6 9 12 15 18 9"/>}
                      </svg>
                    )}
                  </div>
                </th>
                );
              })}
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
                {columns.map(col => {
                  const meta = results.columnMeta?.find(m => m.name === col);
                  const isEditing = editing && editing.row === row && editing.col === col;
                  const editable = !!(onUpdateCell && meta && meta.orgTable && meta.orgName && !meta.pk);
                  return (
                    <td
                      key={col}
                      style={{ ...cellStyle(row[col] ?? null), padding: isEditing ? 0 : undefined }}
                      onDoubleClick={(e) => {
                        if (!editable || !meta) return;
                        e.stopPropagation();
                        const kind = editKindForType(meta.mysqlType);
                        const current = row[col];
                        const draft = current === null || current === undefined
                          ? ''
                          : kind === 'datetime' ? toDatetimeLocal(current)
                          : kind === 'date' ? String(current).slice(0, 10)
                          : kind === 'time' ? String(current).slice(-8)
                          : String(current);
                        setEditing({ row, col, draft, kind, saving: false, error: null });
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
                            if (raw === '' && !editedMeta.notNull) value = null;
                            else if (editing.kind === 'number') value = raw === '' ? '' : Number(raw);
                            else if (editing.kind === 'datetime') value = raw === '' ? null : fromDatetimeLocal(raw);
                            else value = raw;

                            const currentVal = editing.row[editing.col] ?? null;
                            if (value === currentVal) { setEditing(null); return; }

                            setConfirmUpdate({
                              row: editing.row,
                              target: { table: del.target.table, where: del.target.where, column: editedMeta.orgName, value },
                              error: null,
                              saving: false,
                            });
                          }}
                        />
                      ) : (
                        row[col] === null ? <em>NULL</em> : String(row[col])
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
        const { target, reason } = resolveDeleteTarget(contextMenu.row, results.columnMeta);
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
                background: 'transparent', color: target ? t.textPrimary : t.textMuted,
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
    </div>
  );
}

interface CellEditorProps {
  t: Theme;
  kind: EditKind;
  draft: string;
  saving: boolean;
  error: string | null;
  suspended?: boolean;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function CellEditor({ t, kind, draft, saving, error, suspended, inputRef, onChange, onCommit, onCancel }: CellEditorProps) {
  const inputType = kind === 'number' ? 'number'
    : kind === 'date' ? 'date'
    : kind === 'datetime' ? 'datetime-local'
    : kind === 'time' ? 'time'
    : 'text';

  const inputStyle: CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    padding: '6px 12px', margin: 0,
    background: t.bgSurface, color: t.textPrimary,
    border: `1px solid ${error ? t.colorError : t.accent}`,
    outline: 'none', borderRadius: 2,
    fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
  };

  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        type={inputType}
        value={draft}
        disabled={saving}
        step={kind === 'number' ? 'any' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        onBlur={() => { if (!saving && !error && !suspended) onCancel(); }}
        style={inputStyle}
      />
      {error && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 10,
          marginTop: 2, padding: '4px 8px',
          background: t.colorErrorBg, border: `1px solid ${t.colorErrorBorder}`,
          borderRadius: 3, color: t.colorError, fontSize: 11,
          fontFamily: '"IBM Plex Sans", sans-serif', whiteSpace: 'nowrap',
          boxShadow: t.shadowMd,
        }}>{error}</div>
      )}
    </div>
  );
}

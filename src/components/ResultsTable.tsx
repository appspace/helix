import { useState, CSSProperties } from 'react';
import type { Theme } from '../theme';

export interface QueryResults {
  columns: string[];
  rows: Record<string, string | number | null>[];
}

interface ResultsTableProps {
  results: QueryResults | null;
  isRunning: boolean;
  error: string | null;
  executionTime: number | null;
  t: Theme;
}

export function ResultsTable({ results, isRunning, error, executionTime, t }: ResultsTableProps) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedRow, setSelectedRow] = useState<number | null>(null);

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
    </div>
  );
}

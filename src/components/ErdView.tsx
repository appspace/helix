import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../theme';
import type { SchemaData } from '../api';
import { buildErdModel, ERD_HEADER_HEIGHT, ERD_ROW_HEIGHT } from '../lib/erdModel';
import type { ErdColumnKind, ErdTable } from '../lib/erdModel';
import { layoutErd, borderPoint } from '../lib/erdLayout';
import type { ErdLayout, ErdLayoutNode } from '../lib/erdLayout';

interface ErdViewProps {
  schema: SchemaData;
  activeSchema: string;
  /** Table to centre on — its neighbours come along. Null draws the whole schema. */
  table: string | null;
  /** Opens the table in a query tab; the diagram closes on the way. */
  onOpenTable: (name: string) => void;
  onClose: () => void;
  t: Theme;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
/** Pointer travel (px) below which a mouse-up still counts as a click, not a drag. */
const CLICK_SLOP = 4;

type Transform = { x: number; y: number; k: number };

/** Stable identity so `nodes` doesn't re-derive on every render before a drag. */
const EMPTY_POSITIONS: Record<string, { x: number; y: number }> = {};

/** Scale and centre the diagram so all of it is visible in the viewport. */
function fitTransform(diagram: { width: number; height: number }, view: { width: number; height: number }): Transform {
  if (diagram.width <= 0 || diagram.height <= 0 || view.width <= 0 || view.height <= 0) {
    return { x: 0, y: 0, k: 1 };
  }
  const k = Math.min(view.width / diagram.width, view.height / diagram.height, 1);
  return {
    k,
    x: (view.width - diagram.width * k) / 2,
    y: (view.height - diagram.height * k) / 2,
  };
}

const KEY_GLYPH: Record<ErdColumnKind, string> = { 'pk': '◆', 'fk': '◇', 'pk-fk': '◈' };

export function ErdView({ schema, activeSchema, table, onOpenTable, onClose, t }: ErdViewProps) {
  const model = useMemo(() => buildErdModel(schema, activeSchema, table), [schema, activeSchema, table]);
  const diagram = useMemo(
    () => layoutErd(
      model.tables.map(tb => ({ table: tb.name, width: tb.width, height: tb.height })),
      model.relations,
    ),
    [model],
  );

  const [hovered, setHovered] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  // Set while a drag is in flight; `moved` decides drag-versus-click on mouse-up.
  const dragRef = useRef<{ table: string | null; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  // Both pieces of interaction state carry the diagram they belong to, so a new
  // diagram (opening it, or switching schema underneath) drops back to the
  // freshly-fitted view without an effect writing state on every render pass.
  const [movedNodes, setMovedNodes] = useState<{ of: ErdLayout; positions: Record<string, { x: number; y: number }> } | null>(null);
  const [panned, setPanned] = useState<{ of: ErdLayout; transform: Transform } | null>(null);

  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Until the user pans or zooms, the diagram stays fitted — including across a
  // window resize.
  const fitted = useMemo(() => fitTransform(diagram, viewSize), [diagram, viewSize]);
  const transform = panned?.of === diagram ? panned.transform : fitted;
  const positions = movedNodes?.of === diagram ? movedNodes.positions : EMPTY_POSITIONS;

  const fitToView = () => setPanned(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const nodes: ErdLayoutNode[] = useMemo(
    () => diagram.nodes.map(n => ({ ...n, ...(positions[n.table] ?? {}) })),
    [diagram, positions],
  );
  const nodeByName = useMemo(() => new Map(nodes.map(n => [n.table, n])), [nodes]);
  const tableByName = useMemo(() => new Map(model.tables.map(tb => [tb.name, tb])), [model]);

  const onMouseDown = (e: React.MouseEvent, table: string | null) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const origin = table ? nodeByName.get(table) : null;
    dragRef.current = {
      table,
      startX: e.clientX,
      startY: e.clientY,
      originX: origin ? origin.x : transform.x,
      originY: origin ? origin.y : transform.y,
      moved: false,
    };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > CLICK_SLOP) drag.moved = true;
      if (!drag.moved) return;

      if (drag.table) {
        // Pointer movement is in screen pixels; diagram coordinates are zoomed.
        const moved = { x: drag.originX + dx / transform.k, y: drag.originY + dy / transform.k };
        setMovedNodes(prev => ({
          of: diagram,
          positions: { ...(prev?.of === diagram ? prev.positions : {}), [drag.table!]: moved },
        }));
      } else {
        setPanned({ of: diagram, transform: { ...transform, x: drag.originX + dx, y: drag.originY + dy } });
      }
    };
    const up = (e: MouseEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag && drag.table && !drag.moved && e.button === 0) onOpenTable(drag.table);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [transform, diagram, onOpenTable]);

  const onWheel = (e: React.WheelEvent) => {
    const el = viewRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, transform.k * Math.exp(-e.deltaY * 0.0015)));
    // Keep the point under the cursor pinned while the scale changes.
    setPanned({
      of: diagram,
      transform: {
        k,
        x: px - (px - transform.x) * (k / transform.k),
        y: py - (py - transform.y) * (k / transform.k),
      },
    });
  };

  const s = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 } as CSSProperties,
    modal: { background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 8, width: '92vw', height: '88vh', display: 'flex', flexDirection: 'column', fontFamily: '"IBM Plex Sans", sans-serif', color: t.textPrimary, boxShadow: t.shadowModal, overflow: 'hidden' } as CSSProperties,
    header: { padding: '12px 16px', borderBottom: `1px solid ${t.borderSubtle}`, display: 'flex', alignItems: 'center', gap: 10 } as CSSProperties,
    title: { margin: 0, fontSize: 14, fontWeight: 600 } as CSSProperties,
    subtitle: { fontSize: 11, color: t.textMuted, fontFamily: 'monospace' } as CSSProperties,
    hint: { marginLeft: 'auto', fontSize: 11, color: t.textMuted } as CSSProperties,
    btn: { padding: '5px 12px', fontSize: 12, fontFamily: 'inherit', background: 'transparent', color: t.textSecondary, border: `1px solid ${t.border}`, borderRadius: 4, cursor: 'pointer' } as CSSProperties,
    canvas: { flex: 1, position: 'relative', overflow: 'hidden', background: t.bgBase, cursor: 'grab' } as CSSProperties,
    empty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.textMuted, fontSize: 12, textAlign: 'center', padding: 24 } as CSSProperties,
    footer: { padding: '9px 16px', borderTop: `1px solid ${t.borderSubtle}`, display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: t.textMuted } as CSSProperties,
  };

  const relationCount = model.relations.length;
  const relatedCount = Math.max(0, model.tables.length - 1);

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <h3 style={s.title}>{table ? 'Dependencies' : 'Foreign-key diagram'}</h3>
          <span style={s.subtitle}>{table ? `${activeSchema}.${table}` : activeSchema}</span>
          <span style={s.hint}>Click a table to query it · drag to rearrange</span>
          <button style={s.btn} onClick={fitToView}>Fit</button>
          <button style={s.btn} onClick={onClose}>Close</button>
        </div>

        <div
          ref={viewRef}
          style={s.canvas}
          onWheel={onWheel}
          onMouseDown={(e) => onMouseDown(e, null)}
        >
          {model.tables.length === 0 && (
            <div style={s.empty}>
              {table ? `\`${table}\` is no longer in this schema.` : 'No tables in this schema.'}
            </div>
          )}

          <svg width="100%" height="100%" style={{ display: 'block' }}>
            <defs>
              <marker id="erd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 z" fill={t.textMuted}/>
              </marker>
              <marker id="erd-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 z" fill={t.accent}/>
              </marker>
            </defs>

            <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
              {model.relations.map((rel, i) => {
                const from = nodeByName.get(rel.from);
                const to = nodeByName.get(rel.to);
                if (!from || !to) return null;
                const active = hovered === rel.from || hovered === rel.to;
                const stroke = active ? t.accent : t.textMuted;

                if (rel.from === rel.to) {
                  // Self-reference: a loop off the box's top-right corner.
                  const x = from.x + from.width;
                  const y = from.y + 14;
                  return (
                    <path
                      key={`${rel.from}-self-${i}`}
                      d={`M ${x} ${y} c 34 -12 34 26 2 20`}
                      fill="none" stroke={stroke} strokeWidth={1.2}
                      markerEnd={`url(#${active ? 'erd-arrow-active' : 'erd-arrow'})`}
                      opacity={active ? 1 : 0.75}
                    >
                      <title>{rel.label}</title>
                    </path>
                  );
                }

                const a = borderPoint(from, to);
                const b = borderPoint(to, from);
                return (
                  <line
                    key={`${rel.from}-${rel.to}-${i}`}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={stroke} strokeWidth={active ? 1.6 : 1.1}
                    markerEnd={`url(#${active ? 'erd-arrow-active' : 'erd-arrow'})`}
                    opacity={active ? 1 : 0.7}
                  >
                    <title>{rel.label}</title>
                  </line>
                );
              })}

              {nodes.map(node => {
                const box = tableByName.get(node.table) as ErdTable;
                const active = hovered === node.table || box.isFocus;
                return (
                  <g
                    key={node.table}
                    transform={`translate(${node.x},${node.y})`}
                    style={{ cursor: 'pointer' }}
                    onMouseDown={(e) => onMouseDown(e, node.table)}
                    onMouseEnter={() => setHovered(node.table)}
                    onMouseLeave={() => setHovered(h => (h === node.table ? null : h))}
                  >
                    <title>{`${box.name} · ${box.rows.toLocaleString()} rows — click to query, drag to move`}</title>
                    <rect
                      width={node.width} height={node.height} rx={5}
                      fill={t.bgSurface}
                      stroke={active ? t.accent : t.border}
                      strokeWidth={active ? 1.6 : 1}
                    />
                    <rect width={node.width} height={ERD_HEADER_HEIGHT} rx={5} fill={active ? t.accentMuted : t.bgElevated}/>
                    <rect y={ERD_HEADER_HEIGHT - 6} width={node.width} height={6} fill={active ? t.accentMuted : t.bgElevated}/>
                    <line x1={0} y1={ERD_HEADER_HEIGHT} x2={node.width} y2={ERD_HEADER_HEIGHT} stroke={t.borderSubtle} strokeWidth={1}/>
                    <text
                      x={10} y={ERD_HEADER_HEIGHT / 2 + 4}
                      fill={active ? t.textAccent : t.textPrimary}
                      fontSize={11.5} fontWeight={box.isFocus ? 700 : 600}
                      fontFamily='"IBM Plex Sans", sans-serif'
                    >
                      {box.name}
                    </text>

                    {box.columns.map((c, i) => {
                      const y = ERD_HEADER_HEIGHT + 12 + i * ERD_ROW_HEIGHT;
                      return (
                        <g key={c.name}>
                          <text x={10} y={y} fill={c.kind === 'fk' ? t.textSecondary : t.colorInfo} fontSize={9.5} fontFamily='"JetBrains Mono", monospace'>
                            {KEY_GLYPH[c.kind]}
                          </text>
                          <text x={22} y={y} fill={t.textSecondary} fontSize={10.5} fontFamily='"JetBrains Mono", monospace'>
                            {c.name}
                          </text>
                          <text x={node.width - 10} y={y} textAnchor="end" fill={t.textMuted} fontSize={9.5} fontFamily='"JetBrains Mono", monospace'>
                            {c.type}
                          </text>
                        </g>
                      );
                    })}

                    {box.hiddenColumns > 0 && (
                      <text
                        x={10}
                        y={ERD_HEADER_HEIGHT + 12 + box.columns.length * ERD_ROW_HEIGHT}
                        fill={t.textMuted} fontSize={9.5} fontStyle="italic"
                        fontFamily='"IBM Plex Sans", sans-serif'
                      >
                        +{box.hiddenColumns} more {box.hiddenColumns === 1 ? 'column' : 'columns'}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        <div style={s.footer}>
          {table
            ? <span>{relatedCount} related {relatedCount === 1 ? 'table' : 'tables'}</span>
            : <span>{model.tables.length} {model.tables.length === 1 ? 'table' : 'tables'}</span>}
          <span>{relationCount} {relationCount === 1 ? 'relationship' : 'relationships'}</span>
          {model.crossSchemaCount > 0 && (
            <span>{model.crossSchemaCount} pointing outside this schema (not drawn)</span>
          )}
          {relationCount === 0 && model.tables.length > 0 && (
            <span style={{ color: t.textSecondary }}>
              {table
                ? `Nothing references \`${table}\`, and it references nothing.`
                : 'No foreign keys in this schema — the tables are laid out on their own.'}
            </span>
          )}
          <span style={{ marginLeft: 'auto' }}>Scroll to zoom · {Math.round(transform.k * 100)}%</span>
        </div>
      </div>
    </div>
  );
}

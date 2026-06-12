import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { Theme } from '../theme';

interface ExplainPlanProps {
  plan: unknown;
  /** Raw EXPLAIN statement that produced this plan; shown verbatim in a footer toggle. */
  explainSql?: string;
  t: Theme;
}

// MySQL EXPLAIN FORMAT=JSON nodes are loosely typed — the only thing we can
// rely on is that nested operators are keyed by recognisable names. Treat the
// tree as an arbitrary object and recurse over known operator keys.
type Node = Record<string, unknown>;

function isObject(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getStr(n: Node, k: string): string | undefined {
  const v = n[k];
  return typeof v === 'string' ? v : undefined;
}

function getNum(n: Node, k: string): number | undefined {
  const v = n[k];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

interface Severity {
  label: string;
  /** 'danger' = full scan / temp; 'warn' = filesort / no chosen key; 'info' = neutral hint */
  level: 'danger' | 'warn' | 'info';
  tip: string;
}

function collectWarnings(node: Node): Severity[] {
  const out: Severity[] = [];
  const access = getStr(node, 'access_type');
  const key = getStr(node, 'key');
  const possible = node['possible_keys'];

  if (access === 'ALL') {
    out.push({
      label: 'Full table scan',
      level: 'danger',
      tip: 'access_type = ALL — MySQL reads every row. Add an index covering the WHERE / JOIN columns.',
    });
  }
  if (access === 'index') {
    out.push({
      label: 'Full index scan',
      level: 'warn',
      tip: 'access_type = index — MySQL scans the entire index. A more selective predicate or composite index may help.',
    });
  }
  if (!key && access && access !== 'system' && access !== 'const') {
    const noCandidates = !Array.isArray(possible) || possible.length === 0;
    out.push({
      label: noCandidates ? 'No usable index' : 'No index chosen',
      level: noCandidates ? 'danger' : 'warn',
      tip: noCandidates
        ? 'possible_keys is empty — there is no index the optimiser could use.'
        : `MySQL had candidate indexes (${(possible as unknown[]).join(', ')}) but chose none — check selectivity or join order.`,
    });
  }
  if (node['using_temporary_table'] === true) {
    out.push({
      label: 'Temporary table',
      level: 'danger',
      tip: 'MySQL materialises an intermediate temp table — costly on large inputs. Often triggered by GROUP BY / DISTINCT on un-indexed columns.',
    });
  }
  if (node['using_filesort'] === true) {
    out.push({
      label: 'Filesort',
      level: 'warn',
      tip: 'Results are sorted outside an index. An ORDER BY backed by a matching index avoids the extra sort pass.',
    });
  }
  return out;
}

interface NodeRender {
  kind: 'block' | 'table' | 'nested_loop' | 'ordering' | 'grouping' | 'union' | 'attached' | 'materialized' | 'duplicates' | 'unknown';
  title: string;
  /** Lines of "label: value" rendered below the title. */
  stats: { label: string; value: string }[];
  warnings: Severity[];
  children: NodeRender[];
}

function fmtCost(node: Node): string | undefined {
  const ci = node['cost_info'];
  if (!isObject(ci)) return undefined;
  return getStr(ci, 'query_cost') ?? getStr(ci, 'read_cost') ?? getStr(ci, 'eval_cost');
}

function buildTable(t: Node): NodeRender {
  const name = getStr(t, 'table_name') ?? '(unknown)';
  const access = getStr(t, 'access_type');
  const key = getStr(t, 'key');
  const possible = Array.isArray(t['possible_keys']) ? (t['possible_keys'] as unknown[]).join(', ') : undefined;
  const rows = getNum(t, 'rows_examined_per_scan');
  const produced = getNum(t, 'rows_produced_per_join');
  const filtered = getStr(t, 'filtered');
  const cost = fmtCost(t);
  const cond = getStr(t, 'attached_condition');
  const ref = Array.isArray(t['ref']) ? (t['ref'] as unknown[]).join(', ') : undefined;

  const stats: { label: string; value: string }[] = [];
  if (access) stats.push({ label: 'access_type', value: access });
  if (key) stats.push({ label: 'key', value: key });
  else if (possible) stats.push({ label: 'possible_keys', value: possible });
  if (ref) stats.push({ label: 'ref', value: ref });
  if (rows !== undefined) stats.push({ label: 'rows examined', value: rows.toLocaleString() });
  if (produced !== undefined) stats.push({ label: 'rows produced', value: produced.toLocaleString() });
  if (filtered) stats.push({ label: 'filtered', value: `${filtered}%` });
  if (cost) stats.push({ label: 'cost', value: cost });
  if (cond) stats.push({ label: 'condition', value: cond });

  const children: NodeRender[] = [];
  const attached = t['attached_subqueries'];
  if (Array.isArray(attached)) {
    for (const sub of attached) {
      if (isObject(sub)) children.push(buildNode(sub, 'attached'));
    }
  }
  const mat = t['materialized_from_subquery'];
  if (isObject(mat)) children.push(buildNode(mat, 'materialized'));

  return {
    kind: 'table',
    title: `Table: ${name}`,
    stats,
    warnings: collectWarnings(t),
    children,
  };
}

function buildNode(node: Node, hint?: 'attached' | 'materialized' | 'duplicates' | 'union'): NodeRender {
  // Query block — usually the outermost wrapper. May contain nested_loop /
  // table / ordering_operation / grouping_operation / union_result.
  if (isObject(node['query_block'])) {
    const block = node['query_block'] as Node;
    return buildNode(block);
  }

  if ('table' in node && isObject(node['table'])) {
    return buildTable(node['table'] as Node);
  }

  if (Array.isArray(node['nested_loop'])) {
    const children = (node['nested_loop'] as unknown[])
      .filter(isObject)
      .map(c => buildNode(c as Node));
    return {
      kind: 'nested_loop',
      title: 'Nested loop join',
      stats: costStat(node),
      warnings: collectWarnings(node),
      children,
    };
  }

  if (isObject(node['ordering_operation'])) {
    const inner = node['ordering_operation'] as Node;
    const stats = costStat(inner);
    const usingFs = inner['using_filesort'] === true;
    return {
      kind: 'ordering',
      title: usingFs ? 'Ordering (filesort)' : 'Ordering',
      stats,
      warnings: collectWarnings(inner),
      children: childrenFromInner(inner),
    };
  }

  if (isObject(node['grouping_operation'])) {
    const inner = node['grouping_operation'] as Node;
    return {
      kind: 'grouping',
      title: 'Grouping',
      stats: costStat(inner),
      warnings: collectWarnings(inner),
      children: childrenFromInner(inner),
    };
  }

  if (isObject(node['duplicates_removal'])) {
    const inner = node['duplicates_removal'] as Node;
    return {
      kind: 'duplicates',
      title: 'Duplicates removal',
      stats: costStat(inner),
      warnings: collectWarnings(inner),
      children: childrenFromInner(inner),
    };
  }

  if (isObject(node['union_result']) || hint === 'union') {
    const inner = (node['union_result'] as Node) ?? node;
    const specs = Array.isArray(inner['query_specifications']) ? inner['query_specifications'] as unknown[] : [];
    return {
      kind: 'union',
      title: 'Union',
      stats: [],
      warnings: [],
      children: specs.filter(isObject).map(s => buildNode(s as Node)),
    };
  }

  // Fallback: unknown shape — render the JSON so the user sees something.
  return {
    kind: hint === 'attached' ? 'attached' : hint === 'materialized' ? 'materialized' : 'unknown',
    title: hint === 'attached' ? 'Attached subquery'
      : hint === 'materialized' ? 'Materialised subquery'
      : 'Node',
    stats: [{ label: 'json', value: safeStringify(node, 240) }],
    warnings: [],
    children: [],
  };
}

function childrenFromInner(inner: Node): NodeRender[] {
  // `buffer_result` is a transparent wrapper MySQL inserts under grouping /
  // ordering operations when it materialises an intermediate set. It carries
  // its own warning flags (using_temporary_table) which we surface on the
  // parent rather than rendering a separate node — otherwise the join tree
  // would be hidden one level deeper than the user expects.
  let cursor: Node = inner;
  for (let i = 0; i < 4; i++) {
    if (isObject(cursor['buffer_result'])) {
      cursor = cursor['buffer_result'] as Node;
      continue;
    }
    break;
  }

  // ordering / grouping / duplicates wrap a single child operator under a
  // known key. Recurse into the first one we find.
  const keys = ['nested_loop', 'table', 'grouping_operation', 'ordering_operation', 'duplicates_removal', 'union_result'];
  for (const k of keys) {
    if (k in cursor) {
      const wrapper: Node = { [k]: cursor[k] };
      return [buildNode(wrapper)];
    }
  }
  return [];
}

function costStat(node: Node): { label: string; value: string }[] {
  const cost = fmtCost(node);
  return cost ? [{ label: 'cost', value: cost }] : [];
}

function safeStringify(v: unknown, max: number): string {
  let s: string;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function ExplainPlan({ plan, explainSql, t }: ExplainPlanProps) {
  const [showJson, setShowJson] = useState(false);

  const s = {
    root: { flex: 1, overflow: 'auto', padding: 16, background: t.bgBase, fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
    header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, fontSize: 12, color: t.textMuted } as CSSProperties,
    legendChip: { fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 3, fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
    rootCard: { background: t.bgSurface, border: `1px solid ${t.border}`, borderRadius: 6, padding: 0 } as CSSProperties,
    empty: { padding: '32px 20px', textAlign: 'center', color: t.textMuted, fontSize: 12 } as CSSProperties,
    jsonToggle: { display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 12, padding: '4px 8px', background: 'none', border: `1px solid ${t.border}`, borderRadius: 4, color: t.textSecondary, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 } as CSSProperties,
    jsonBox: { marginTop: 8, padding: 12, background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 4, fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: t.textPrimary, whiteSpace: 'pre', overflow: 'auto', maxHeight: 320 } as CSSProperties,
    sqlBox: { marginTop: 12, padding: '6px 10px', background: t.bgToolbar, border: `1px solid ${t.borderSubtle}`, borderRadius: 4, fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: t.textMuted, overflow: 'auto', whiteSpace: 'nowrap' } as CSSProperties,
  };

  if (!isObject(plan)) {
    return (
      <div style={s.root}>
        <div style={s.empty}>No plan available.</div>
      </div>
    );
  }

  const root = buildNode(plan as Node);

  return (
    <div style={s.root}>
      <div style={s.header}>
        <span style={{ fontSize: 13, color: t.textPrimary, fontWeight: 600 }}>Query plan</span>
        <span>·</span>
        <SeverityLegend t={t} chipStyle={s.legendChip} />
      </div>

      <div style={s.rootCard}>
        <PlanTree node={root} t={t} depth={0} />
      </div>

      <button style={s.jsonToggle} onClick={() => setShowJson(v => !v)}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {showJson
            ? <polyline points="18 15 12 9 6 15"/>
            : <polyline points="6 9 12 15 18 9"/>}
        </svg>
        {showJson ? 'Hide raw JSON' : 'Show raw JSON'}
      </button>
      {showJson && (
        <div style={s.jsonBox}>{JSON.stringify(plan, null, 2)}</div>
      )}

      {explainSql && (
        <div style={s.sqlBox} title="EXPLAIN statement that produced this plan">{explainSql}</div>
      )}
    </div>
  );
}

function SeverityLegend({ t, chipStyle }: { t: Theme; chipStyle: CSSProperties }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ ...chipStyle, background: t.colorErrorBg, color: t.colorError, border: `1px solid ${t.colorErrorBorder}` }}>danger</span>
      <span style={{ ...chipStyle, background: t.colorWarningBg, color: t.colorWarning, border: `1px solid ${t.colorWarning}` }}>warn</span>
      <span style={{ marginLeft: 4 }}>= scan / temp / filesort / missing index</span>
    </span>
  );
}

interface PlanTreeProps {
  node: NodeRender;
  t: Theme;
  depth: number;
}

function PlanTree({ node, t, depth }: PlanTreeProps) {
  // Title-bar tint by kind/severity so the tree shape is legible at a glance.
  const dangerCount = node.warnings.filter(w => w.level === 'danger').length;
  const warnCount = node.warnings.filter(w => w.level === 'warn').length;
  const headBg = dangerCount > 0
    ? t.colorErrorBg
    : warnCount > 0
      ? t.colorWarningBg
      : t.bgSurface;
  const headBorder = dangerCount > 0
    ? t.colorErrorBorder
    : warnCount > 0
      ? t.colorWarning
      : t.border;

  const s = {
    wrapper: { borderTop: depth === 0 ? 'none' : `1px solid ${t.borderSubtle}` } as CSSProperties,
    head: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
      background: headBg, borderLeft: `3px solid ${headBorder}`,
      fontSize: 12,
    } as CSSProperties,
    title: { fontWeight: 600, color: t.textPrimary } as CSSProperties,
    stats: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', padding: '6px 14px 8px 26px', fontSize: 11, color: t.textMuted, fontFamily: '"JetBrains Mono", monospace' } as CSSProperties,
    statItem: { whiteSpace: 'nowrap' } as CSSProperties,
    statLabel: { color: t.textMuted, marginRight: 4 } as CSSProperties,
    statVal: { color: t.textPrimary } as CSSProperties,
    children: { paddingLeft: depth === 0 ? 0 : 18, borderLeft: depth === 0 ? 'none' : `1px dashed ${t.borderSubtle}`, marginLeft: depth === 0 ? 0 : 12 } as CSSProperties,
  };

  return (
    <div style={s.wrapper}>
      <div style={s.head}>
        <KindIcon kind={node.kind} t={t} />
        <span style={s.title}>{node.title}</span>
        {node.warnings.map((w, i) => <WarningChip key={i} warning={w} t={t} />)}
      </div>
      {node.stats.length > 0 && (
        <div style={s.stats}>
          {node.stats.map((st, i) => (
            <span key={i} style={s.statItem}>
              <span style={s.statLabel}>{st.label}:</span>
              <span style={s.statVal}>{st.value}</span>
            </span>
          ))}
        </div>
      )}
      {node.children.length > 0 && (
        <div style={s.children}>
          {node.children.map((c, i) => <PlanTree key={i} node={c} t={t} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );
}

function WarningChip({ warning, t }: { warning: Severity; t: Theme }) {
  const bg = warning.level === 'danger'
    ? t.colorErrorBg
    : warning.level === 'warn'
      ? t.colorWarningBg
      : t.bgElevated;
  const fg = warning.level === 'danger'
    ? t.colorError
    : warning.level === 'warn'
      ? t.colorWarning
      : t.textSecondary;
  const border = warning.level === 'danger'
    ? t.colorErrorBorder
    : warning.level === 'warn'
      ? t.colorWarning
      : t.border;
  return (
    <span
      title={warning.tip}
      style={{
        fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 3,
        background: bg, color: fg, border: `1px solid ${border}`,
        textTransform: 'uppercase', letterSpacing: '0.04em',
        fontFamily: '"IBM Plex Sans", sans-serif',
      }}
    >
      {warning.label}
    </span>
  );
}

function KindIcon({ kind, t }: { kind: NodeRender['kind']; t: Theme }) {
  const stroke = t.textMuted;
  const size = 14;
  switch (kind) {
    case 'table':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="4" x2="9" y2="20"/>
        </svg>
      );
    case 'nested_loop':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="12" r="4"/><circle cx="16" cy="12" r="4"/>
        </svg>
      );
    case 'ordering':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="6" x2="14" y2="6"/><line x1="4" y1="12" x2="11" y2="12"/><line x1="4" y1="18" x2="8" y2="18"/><polyline points="18 7 18 17 21 14"/>
        </svg>
      );
    case 'grouping':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="12" r="3"/><circle cx="14" cy="6" r="3"/><circle cx="14" cy="18" r="3"/><line x1="9" y1="11" x2="11" y2="8"/><line x1="9" y1="13" x2="11" y2="16"/>
        </svg>
      );
    case 'union':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 4v10a7 7 0 0 0 14 0V4"/>
        </svg>
      );
    case 'attached':
    case 'materialized':
    case 'duplicates':
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9"/>
        </svg>
      );
  }
}

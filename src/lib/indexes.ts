import type { ColumnMeta, SchemaData, SchemaIndex } from '../api';

/** One index a column belongs to, plus where the column sits inside it. */
export interface IndexMembership {
  index: string;
  unique: boolean;
  /** 1-based position of the column within the index. */
  position: number;
  /** Every column of the index, in index order. */
  columns: string[];
  /** Access method as the engine reports it: 'BTREE', 'FULLTEXT', 'gin', … */
  type: string;
}

export interface IndexMark {
  /**
   * `leading` — the column is the leftmost column of at least one index, so a
   * predicate on it alone can use that index.
   * `trailing` — it only appears deeper inside composite indexes, so it needs
   * the preceding columns constrained before the index can be used.
   */
  kind: 'leading' | 'trailing';
  /** Ordered leading-first, so the most useful index reads first in the tooltip. */
  memberships: IndexMembership[];
}

// MySQL folds column and table names case-insensitively, and Postgres folds
// unquoted identifiers to lowercase, so match on the lowered name rather than
// requiring information_schema and the result-set metadata to agree on case.
// MongoDB is case-sensitive, but it leaves `orgTable` empty and so never
// reaches this path.
const fold = (s: string) => s.toLowerCase();

function membershipsFor(indexes: SchemaIndex[], column: string): IndexMembership[] {
  const target = fold(column);
  const found: IndexMembership[] = [];
  for (const idx of indexes) {
    const position = idx.columns.findIndex(c => fold(c) === target) + 1;
    if (position === 0) continue;
    found.push({
      index: idx.name,
      unique: idx.unique,
      position,
      columns: idx.columns,
      type: idx.type,
    });
  }
  // Leftmost membership first: it is the one that decides whether the column
  // can drive an index on its own.
  return found.sort((a, b) => a.position - b.position);
}

/**
 * Resolve the index marks for a result-set column, or null when the column
 * isn't indexed — or can't be traced back to a table at all (an expression, an
 * aggregate, or a driver that doesn't report the originating table).
 */
export function indexMarkFor(
  schemaData: SchemaData | undefined,
  meta: ColumnMeta | undefined,
): IndexMark | null {
  if (!schemaData || !meta?.orgTable || !meta.orgName) return null;
  const table = schemaData.tables.find(x => fold(x.name) === fold(meta.orgTable));
  const memberships = membershipsFor(table?.indexes ?? [], meta.orgName);
  if (memberships.length === 0) return null;
  return {
    kind: memberships[0].position === 1 ? 'leading' : 'trailing',
    memberships,
  };
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// 'BTREE' (MySQL) and 'btree' (Postgres/Mongo) are the unremarkable default —
// only call out an access method when it changes how the index can be used.
function isSpecialType(type: string): boolean {
  return Boolean(type) && fold(type) !== 'btree';
}

function typeSuffix(type: string): string {
  return isSpecialType(type) ? ` ${type}` : '';
}

function describeMembership(m: IndexMembership): string {
  const kind = `${m.unique ? 'unique ' : ''}index${typeSuffix(m.type)}`;
  if (m.columns.length === 1) return `${m.index} — ${kind}`;
  return `${m.index} — ${ordinal(m.position)} of ${m.columns.length} columns (${m.columns.join(', ')})`;
}

/**
 * What each mark colour means. Both entries show in every tooltip — whichever
 * key a reader hovered, they learn the whole scheme — with the one matching the
 * hovered column emphasised.
 */
export const INDEX_MARK_LEGEND: { kind: IndexMark['kind']; text: string }[] = [
  { kind: 'leading', text: 'Leftmost column of an index — a filter on this column alone can use it.' },
  { kind: 'trailing', text: 'Only a later column of a composite index — the earlier columns must be filtered too.' },
];

/**
 * A leading column of a FULLTEXT / gin / 2dsphere / hash index can't be reached
 * by an ordinary comparison, so the legend's promise needs walking back.
 * Returns null when at least one leading index is a plain b-tree.
 */
function caveatFor(mark: IndexMark): string | null {
  if (mark.kind !== 'leading') return null;
  const leading = mark.memberships.filter(m => m.position === 1);
  if (!leading.every(m => isSpecialType(m.type))) return null;
  return `Only a matching ${leading[0].type} predicate can use this index — an ordinary comparison can't.`;
}

export interface IndexMarkTooltip {
  /** One line per index the column belongs to, leftmost membership first. */
  memberships: string[];
  /** Qualifies the legend when no leading index is a plain b-tree; null otherwise. */
  caveat: string | null;
}

/** Tooltip content for a column header carrying an index mark. */
export function describeIndexMark(mark: IndexMark): IndexMarkTooltip {
  return {
    memberships: mark.memberships.map(describeMembership),
    caveat: caveatFor(mark),
  };
}

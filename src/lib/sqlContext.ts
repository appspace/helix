// Light-weight SQL parsing used by the editor's autocomplete. None of this is
// a real parser — it sniffs FROM / JOIN clauses well enough to feed column
// suggestions back to the user. False positives are fine; we'd rather suggest
// a column from a table the user happens to be typing about than miss it.

export interface SqlTableRef {
  /** Bare table identifier as the user typed it (no quotes). */
  table: string;
  /** Optional alias (`FROM users u`, `FROM users AS u`); falls back to the table name. */
  alias: string;
}

/** Strip block & line comments + single-quoted string literals so identifier
 *  matchers inside them can't fire. Double-quoted text is intentionally left
 *  alone — Postgres (and MySQL in ANSI_QUOTES mode) uses `"users"` as an
 *  identifier, and stripping it would prevent the parser from finding such
 *  tables. The trade-off is that a Postgres double-quoted string containing
 *  `FROM` could yield a false positive, but in practice strings use single
 *  quotes in both dialects.
 */
function stripNoise(sql: string): string {
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  out = out.replace(/--[^\n]*/g, ' ');
  out = out.replace(/'(?:[^'\\]|\\.|'')*'/g, s => ' '.repeat(s.length));
  return out;
}

// backtick-quoted, double-quoted, bracket-quoted, or bare identifier.
// Each branch contributes one capturing group → four total per IDENT use.
const IDENT = '(?:`([^`]+)`|"([^"]+)"|\\[([^\\]]+)\\]|([A-Za-z_][A-Za-z0-9_$]*))';

function unquote(raw: string): string {
  if (!raw) return raw;
  const first = raw[0];
  if (first === '`' || first === '"') return raw.slice(1, -1);
  if (first === '[') return raw.slice(1, -1);
  return raw;
}

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'on',
  'join', 'inner', 'outer', 'left', 'right', 'cross', 'full', 'natural',
  'using', 'group', 'order', 'by', 'having', 'limit', 'offset', 'as',
  'lateral', 'union', 'intersect', 'except', 'with', 'distinct', 'all',
  'asc', 'desc', 'true', 'false', 'between', 'like', 'rlike', 'regexp',
  'case', 'when', 'then', 'else', 'end', 'set', 'values', 'into', 'partition',
  'window', 'over',
]);

/**
 * Parse `FROM ... [WHERE | GROUP | ORDER | LIMIT | ...]` and any `JOIN`
 * clauses, returning the referenced tables with their effective aliases.
 *
 * Examples handled:
 *   FROM users
 *   FROM users u
 *   FROM users AS u
 *   FROM `db`.`users` u
 *   FROM users u JOIN orders AS o ON u.id = o.user_id
 *   LEFT JOIN `pivot` p ON ...
 */
export function extractTableRefs(sql: string): SqlTableRef[] {
  const clean = stripNoise(sql);
  const refs: SqlTableRef[] = [];

  // Match `FROM` or any flavour of `JOIN` followed by a (possibly schema-
  // qualified) table identifier and an optional alias. We deliberately don't
  // stop at sub-clauses — JOIN may itself follow another JOIN with no break,
  // and the global regex catches each one independently.
  //
  // The schema-qualifier branch is `IDENT . IDENT`; we keep only the table
  // (second part) because the suggestion list operates on the active schema's
  // table set.
  const re = new RegExp(
    '(?:\\bFROM\\b|\\bJOIN\\b)\\s+' +
    // optional schema. captured but unused; we only need the table
    '(?:' + IDENT + '\\s*\\.\\s*)?' +
    IDENT +
    // optional alias: `AS foo` | `foo` (bare). Bare alias must not be a SQL keyword.
    '(?:\\s+(?:AS\\s+)?' + IDENT + ')?',
    'gi',
  );

  // Each IDENT contributes 4 capturing groups (backtick / double-quote /
  // bracket / bare). With schema + table + alias that's 12 groups total.
  // Indices in the match array: 1-4 = schema (unused), 5-8 = table, 9-12 = alias.
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const tableRaw = m[5] || m[6] || m[7] || m[8];
    if (!tableRaw) continue;
    const table = unquote(tableRaw);
    const aliasRaw = m[9] || m[10] || m[11] || m[12];
    let alias = aliasRaw ? unquote(aliasRaw) : table;

    // A bare-word "alias" that turns out to be a keyword like FROM/WHERE/ON is
    // really the next clause, not an alias. Drop it and use the table name.
    if (!aliasRaw?.startsWith('`') && !aliasRaw?.startsWith('"') && !aliasRaw?.startsWith('[')
        && aliasRaw && SQL_KEYWORDS.has(aliasRaw.toLowerCase())) {
      alias = table;
    }
    refs.push({ table, alias });
  }

  return refs;
}

/** What kinds of identifiers / keywords belong in a given caret position. */
export interface ExpectedSlot {
  /** Which group of keywords (if any) is appropriate at this position. */
  keywords: 'none' | 'statement' | 'expr' | 'by' | 'any';
  /** Whether the position naturally accepts a table name (FROM / JOIN / UPDATE / INTO …). */
  tables: boolean;
  /** Whether the position naturally accepts a column reference. */
  columns: boolean;
}

interface PrevToken {
  /** Identifier characters immediately before the prefix, or '' when none. */
  word: string;
  /** Single punctuation char immediately before the prefix, or null. */
  punct: string | null;
}

function previousToken(text: string, start: number): PrevToken {
  let i = start;
  // Skip the dot we already consumed for qualified prefixes — callers pass the
  // prefix's start, which is *after* the `.`. We still want to look past the
  // qualifier to see what came before it.
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  if (i === 0) return { word: '', punct: null };

  // A quoted identifier (`tbl` / "tbl" / [tbl]) ends with a closing quote.
  // Walk back to the opening quote and treat the enclosed text as a bare word
  // so callers reading FROM/JOIN context don't bail at the closing punctuation.
  const tail = text[i - 1];
  if (tail === '`' || tail === '"' || tail === ']') {
    const open = tail === ']' ? '[' : tail;
    let j = i - 2;
    while (j >= 0 && text[j] !== open) j--;
    if (j >= 0) return { word: text.slice(j + 1, i - 1), punct: null };
  }

  const ch = text[i - 1];
  if (/[(),.=<>!+\-*/%;]/.test(ch)) return { word: '', punct: ch };
  let j = i;
  while (j > 0 && /[A-Za-z0-9_]/.test(text[j - 1])) j--;
  return { word: text.slice(j, i), punct: null };
}

const TABLE_INTRODUCERS = new Set([
  'from', 'join', 'into', 'update', 'table', 'describe', 'desc', 'truncate',
]);
const EXPR_INTRODUCERS = new Set([
  'select', 'where', 'on', 'and', 'or', 'having', 'when', 'then', 'else',
  'by', 'distinct', 'in', 'like', 'between', 'using', 'set',
]);
const EXPR_PUNCT = new Set(['(', ',', '=', '<', '>', '+', '-', '*', '/', '%']);
const HALF_KEYWORDS = new Set(['group', 'order']); // expect "BY" next

/**
 * Decide what suggestions belong at the caret. Used to suppress column names
 * when the user is clearly typing a statement-starter (e.g. `SEL|`) and to
 * suppress keywords when only an identifier makes sense (e.g. `FROM |`).
 */
export function expectedSlot(text: string, prefixStart: number, qualifier: string | null): ExpectedSlot {
  // Qualified prefix (`alias.col|`) is always column-only — punctuation context
  // before the alias is irrelevant.
  if (qualifier) return { keywords: 'none', tables: false, columns: true };

  const prev = previousToken(text, prefixStart);
  const w = prev.word.toLowerCase();

  // Top of file or just after a statement separator → statement-starters only.
  if ((w === '' && prev.punct === null) || prev.punct === ';') {
    return { keywords: 'statement', tables: false, columns: false };
  }
  if (TABLE_INTRODUCERS.has(w)) {
    return { keywords: 'none', tables: true, columns: false };
  }
  if (HALF_KEYWORDS.has(w)) {
    return { keywords: 'by', tables: false, columns: false };
  }
  if (EXPR_INTRODUCERS.has(w) || (prev.punct && EXPR_PUNCT.has(prev.punct))) {
    return { keywords: 'expr', tables: false, columns: true };
  }
  // Unknown context — permissive so we never lock the user out of a useful hint.
  return { keywords: 'any', tables: true, columns: true };
}

export interface ContextAtCaret {
  /** What the user is typing — the partial identifier before the caret. */
  prefix: string;
  /** Caret index of where `prefix` started in the source (for replacement). */
  start: number;
  /** When set, the prefix is qualified — e.g. user typed `u.foo` and the caret
   *  is on `foo`; suggestions should be restricted to columns of the table
   *  that `u` resolves to. */
  qualifier: string | null;
}

/**
 * SQL keyword sets surfaced as autocomplete suggestions, grouped by where
 * they're allowed. Order within each group reflects rough frequency so the
 * popup leads with the most common pick.
 */
export const KEYWORD_GROUPS = {
  statement: [
    'SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE',
    'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'SHOW TABLES', 'DESCRIBE',
    'EXPLAIN', 'WITH', 'USE', 'BEGIN', 'COMMIT', 'ROLLBACK',
  ],
  // Things that read naturally after a column / value in an expression.
  expr: [
    'AND', 'OR', 'NOT', 'IS NULL', 'IS NOT NULL', 'IN', 'NOT IN', 'LIKE',
    'NOT LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'DISTINCT', 'NULL', 'TRUE', 'FALSE',
  ],
  by: ['BY'],
  // Clause keywords appropriate after a complete table/expression — used in
  // the 'any' fallback alongside columns/tables.
  clauses: [
    'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN',
    'LEFT JOIN', 'INNER JOIN', 'ON', 'AS', 'UNION', 'INTERSECT', 'EXCEPT',
  ],
} as const;

/**
 * Inspect the text up to the caret and decide what the user is editing.
 * Returns null when the caret isn't inside an identifier (e.g. just after a
 * space or punctuation other than `.`), so the caller can close the popup.
 */
export function contextAtCaret(text: string, caret: number): ContextAtCaret | null {
  if (caret < 0 || caret > text.length) return null;

  // Walk backwards to find the start of the current identifier prefix.
  let i = caret;
  while (i > 0 && /[A-Za-z0-9_$]/.test(text[i - 1])) i--;
  const prefix = text.slice(i, caret);
  const start = i;

  // Look at the character before the prefix. A `.` means the prefix is
  // qualified — back up further to find the qualifier identifier.
  let qualifier: string | null = null;
  if (i > 0 && text[i - 1] === '.') {
    let j = i - 1;
    while (j > 0 && /[A-Za-z0-9_$`"\][]/.test(text[j - 1])) j--;
    const qRaw = text.slice(j, i - 1).trim();
    qualifier = qRaw ? unquote(qRaw) : null;
  }

  // Empty prefix + no qualifier → user has nothing for us to filter on.
  // Returning null keeps the popup closed; the caller can still call us again
  // once a character is typed.
  if (!prefix && !qualifier) return null;
  return { prefix, start, qualifier };
}

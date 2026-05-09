type CellValue = string | number | boolean | null;

export function parseEnumValues(type: string): string[] | null {
  const match = type.match(/^enum\((.+)\)$/i);
  if (!match) return null;
  const values: string[] = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(match[1])) !== null) {
    values.push(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  }
  return values.length > 0 ? values : null;
}

export function formatSqlValue(v: CellValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return String(v);
}

/**
 * Default query template used when the user clicks a table in the sidebar.
 * Sorts by `pkColumn DESC` when provided so the most recent rows appear first
 * — caller passes null for tables without a single auto-incrementing PK,
 * since descending order is meaningless on UUID/string/composite keys.
 */
export function buildDefaultTableQuery(table: string, pkColumn: string | null): string {
  const orderBy = pkColumn ? `\nORDER BY \`${pkColumn}\` DESC` : '';
  return `SELECT *\nFROM \`${table}\`${orderBy}\nLIMIT 100;`;
}

export function buildInsertSql(table: string, values: Record<string, CellValue>): string {
  const cols = Object.keys(values);
  if (cols.length === 0) return `INSERT INTO \`${table}\` () VALUES ();`;
  const colList = cols.map(c => `\`${c}\``).join(', ');
  const valList = cols.map(c => formatSqlValue(values[c]!)).join(', ');
  return `INSERT INTO \`${table}\`\n  (${colList})\nVALUES\n  (${valList});`;
}

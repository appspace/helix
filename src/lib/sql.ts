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

export function buildInsertSql(table: string, values: Record<string, CellValue>): string {
  const cols = Object.keys(values);
  if (cols.length === 0) return `INSERT INTO \`${table}\` () VALUES ();`;
  const colList = cols.map(c => `\`${c}\``).join(', ');
  const valList = cols.map(c => formatSqlValue(values[c]!)).join(', ');
  return `INSERT INTO \`${table}\`\n  (${colList})\nVALUES\n  (${valList});`;
}

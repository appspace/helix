type CellValue = string | number | null;

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

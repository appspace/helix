import type { RequestHandler } from 'express';
import { getDriver } from '../db.js';

interface WhereClause {
  column: string;
  value: string | number | null;
}

export const postUpdateCell: RequestHandler = async (req, res) => {
  const { schema, table, where, column, value } = req.body as {
    schema?: string;
    table?: string;
    where?: WhereClause[];
    column?: string;
    value?: string | number | boolean | null;
  };

  if (!table || typeof table !== 'string' || !table.trim()) {
    res.status(400).json({ error: 'table is required.' });
    return;
  }
  if (!column || typeof column !== 'string' || !column.trim()) {
    res.status(400).json({ error: 'column is required.' });
    return;
  }
  if (!Array.isArray(where) || where.length === 0) {
    res.status(400).json({ error: 'where is required and must be non-empty.' });
    return;
  }
  if (where.some(w => !w.column || typeof w.column !== 'string')) {
    res.status(400).json({ error: 'each where entry must have a column name.' });
    return;
  }

  const driver = getDriver();
  const qualifiedTable = schema
    ? `${driver.escapeIdent(schema)}.${driver.escapeIdent(table)}`
    : driver.escapeIdent(table);

  const whereClause = where.map(w => `${driver.escapeIdent(w.column)} = ?`).join(' AND ');
  const sql = `UPDATE ${qualifiedTable} SET ${driver.escapeIdent(column)} = ? WHERE ${whereClause}${driver.rowLimitClause(1)}`;
  const params = [value === undefined ? null : value, ...where.map(w => w.value)];

  try {
    const result = await driver.query(sql, params);
    res.json({ affectedRows: result.affectedRows ?? 0, sql });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

import type { RequestHandler } from 'express';
import { getDriver } from '../db.js';

export const postInsertRow: RequestHandler = async (req, res) => {
  const { schema, table, values } = req.body as {
    schema?: string;
    table?: string;
    values?: Record<string, string | number | null>;
  };

  if (!table || typeof table !== 'string' || !table.trim()) {
    res.status(400).json({ error: 'table is required.' });
    return;
  }
  if (!values || typeof values !== 'object' || Object.keys(values).length === 0) {
    res.status(400).json({ error: 'values is required and must have at least one column.' });
    return;
  }

  const driver = getDriver();
  const cols = Object.keys(values);
  const qualifiedTable = schema
    ? `${driver.escapeIdent(schema)}.${driver.escapeIdent(table)}`
    : driver.escapeIdent(table);

  const colList = cols.map(c => driver.escapeIdent(c)).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${qualifiedTable} (${colList}) VALUES (${placeholders})`;
  const params = cols.map(c => values[c]);

  try {
    const result = await driver.query(sql, params);
    res.json({
      affectedRows: result.affectedRows ?? 0,
      insertId: result.insertId ?? null,
      sql,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

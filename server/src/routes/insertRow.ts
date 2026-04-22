import type { RequestHandler } from 'express';
import type { ResultSetHeader } from 'mysql2/promise';
import { getPool } from '../db.js';

const escapeIdent = (s: string) => '`' + s.replace(/`/g, '') + '`';

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

  const cols = Object.keys(values);
  const qualifiedTable = schema
    ? `${escapeIdent(schema)}.${escapeIdent(table)}`
    : escapeIdent(table);

  const colList = cols.map(escapeIdent).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${qualifiedTable} (${colList}) VALUES (${placeholders})`;
  const params = cols.map(c => values[c]);

  try {
    const pool = getPool();
    const [result] = await pool.query(sql, params) as [ResultSetHeader, unknown];
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

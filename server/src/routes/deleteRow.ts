import type { RequestHandler } from 'express';
import type { ResultSetHeader } from 'mysql2/promise';
import { getPool } from '../db.js';

interface WhereClause {
  column: string;
  value: string | number | null;
}

const escapeIdent = (s: string) => '`' + s.replace(/`/g, '') + '`';

export const postDeleteRow: RequestHandler = async (req, res) => {
  const { schema, table, where } = req.body as {
    schema?: string;
    table?: string;
    where?: WhereClause[];
  };

  if (!table || typeof table !== 'string' || !table.trim()) {
    res.status(400).json({ error: 'table is required.' });
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

  const qualifiedTable = schema
    ? `${escapeIdent(schema)}.${escapeIdent(table)}`
    : escapeIdent(table);

  const whereClause = where.map(w => `${escapeIdent(w.column)} = ?`).join(' AND ');
  const sql = `DELETE FROM ${qualifiedTable} WHERE ${whereClause} LIMIT 1`;
  const values = where.map(w => w.value);

  try {
    const pool = getPool();
    const [result] = await pool.query(sql, values) as [ResultSetHeader, unknown];
    res.json({ affectedRows: result.affectedRows ?? 0, sql });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

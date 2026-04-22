import type { RequestHandler } from 'express';
import { getPool } from '../db.js';

const escapeIdent = (s: string) => '`' + s.replace(/`/g, '') + '`';

export const postDropTable: RequestHandler = async (req, res) => {
  const { schema, table } = req.body as { schema?: string; table?: string };
  if (!table || typeof table !== 'string' || !table.trim()) {
    res.status(400).json({ error: 'table is required.' });
    return;
  }
  const qualifiedTable = schema
    ? `${escapeIdent(schema)}.${escapeIdent(table)}`
    : escapeIdent(table);
  const sql = `DROP TABLE ${qualifiedTable}`;
  try {
    const pool = getPool();
    await pool.query(sql);
    res.json({ ok: true, sql });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

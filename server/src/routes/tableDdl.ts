import type { RequestHandler } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from '../db.js';

const escapeIdent = (s: string) => '`' + s.replace(/`/g, '') + '`';

export const getTableDdl: RequestHandler = async (req, res) => {
  const schema = req.query['schema'] as string | undefined;
  const table = req.query['table'] as string | undefined;

  if (!schema || !schema.trim()) {
    res.status(400).json({ error: 'schema query param is required.' });
    return;
  }
  if (!table || !table.trim()) {
    res.status(400).json({ error: 'table query param is required.' });
    return;
  }

  try {
    const pool = getPool();
    const qualified = `${escapeIdent(schema)}.${escapeIdent(table)}`;
    const [rows] = await pool.query<RowDataPacket[]>(`SHOW CREATE TABLE ${qualified}`);
    if (rows.length === 0) {
      res.status(404).json({ error: `No DDL returned for ${qualified}.` });
      return;
    }
    // SHOW CREATE TABLE returns [{ Table: '…', 'Create Table': '…' }] for base tables,
    // or [{ View: '…', 'Create View': '…', character_set_client, collation_connection }] for views.
    const row = rows[0] as Record<string, unknown>;
    const ddl = (row['Create Table'] ?? row['Create View'] ?? '') as string;
    res.json({ ddl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

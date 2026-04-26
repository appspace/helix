import type { RequestHandler } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from '../db.js';

const escapeIdent = (s: string) => '`' + s.replace(/`/g, '') + '`';

export const getTableDdl: RequestHandler = async (req, res) => {
  const schema = req.query['schema'] as string | undefined;
  const table = req.query['table'] as string | undefined;
  const type = (req.query['type'] as string | undefined) ?? 'table';

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

    let sql: string;
    if (type === 'procedure') {
      sql = `SHOW CREATE PROCEDURE ${qualified}`;
    } else if (type === 'trigger') {
      sql = `SHOW CREATE TRIGGER ${qualified}`;
    } else {
      // 'table' or 'view' — SHOW CREATE TABLE works for both
      sql = `SHOW CREATE TABLE ${qualified}`;
    }

    const [rows] = await pool.query<RowDataPacket[]>(sql);
    if (rows.length === 0) {
      res.status(404).json({ error: `No DDL returned for ${qualified}.` });
      return;
    }
    const row = rows[0] as Record<string, unknown>;
    const ddl = (
      row['Create Table'] ??
      row['Create View'] ??
      row['Create Procedure'] ??
      row['SQL Original Statement'] ??   // SHOW CREATE TRIGGER
      ''
    ) as string;
    res.json({ ddl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

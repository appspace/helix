import type { RequestHandler } from 'express';
import { getDriver } from '../db.js';

/**
 * Execute a CREATE TABLE statement composed by the client. The frontend's
 * `CreateTableDialog` builds the DDL via the dialect-aware helper and shows
 * a preview the user can hand-edit before submitting; this route just runs it.
 *
 * No incremental security risk over `/api/query` (which also accepts arbitrary
 * SQL): the dedicated route exists for symmetry with `/api/drop-table` and
 * gives us a hook for post-create logic (audit, schema refresh) later.
 */
export const postCreateTable: RequestHandler = async (req, res) => {
  const { sql } = req.body as { sql?: string };
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    res.status(400).json({ error: 'sql is required.' });
    return;
  }

  try {
    await getDriver().query(sql);
    res.json({ ok: true, sql });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

import type { RequestHandler } from 'express';
import { getDriver } from '../db.js';

/**
 * Execute one or more ALTER TABLE statements composed by the client.
 * The frontend's AlterTableDialog builds the DDL via the dialect-aware helper
 * and shows a preview the user can hand-edit before submitting.
 */
export const postAlterTable: RequestHandler = async (req, res) => {
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

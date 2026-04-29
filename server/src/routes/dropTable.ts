import type { RequestHandler } from 'express';
import { getDriver } from '../db.js';

export const postDropTable: RequestHandler = async (req, res) => {
  const { schema, table } = req.body as { schema?: string; table?: string };
  if (!table || typeof table !== 'string' || !table.trim()) {
    res.status(400).json({ error: 'table is required.' });
    return;
  }

  const driver = getDriver();
  const qualifiedTable = schema
    ? `${driver.escapeIdent(schema)}.${driver.escapeIdent(table)}`
    : driver.escapeIdent(table);
  const sql = `DROP TABLE ${qualifiedTable}`;

  try {
    await driver.query(sql);
    res.json({ ok: true, sql });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

import type { RequestHandler } from 'express';
import { getDriver } from '../db.js';

export const getTableDdl: RequestHandler = async (req, res) => {
  const schema = req.query['schema'] as string | undefined;
  const table = req.query['table'] as string | undefined;
  const type = (req.query['type'] as string | undefined) ?? 'table';

  if (!schema?.trim()) {
    res.status(400).json({ error: 'schema query param is required.' });
    return;
  }
  if (!table?.trim()) {
    res.status(400).json({ error: 'table query param is required.' });
    return;
  }
  if (!['table', 'view', 'procedure', 'trigger'].includes(type)) {
    res.status(400).json({ error: `Invalid type "${type}". Must be one of: table, view, procedure, trigger.` });
    return;
  }

  try {
    const ddl = await getDriver().getTableDdl(schema, table, type as 'table' | 'view' | 'procedure' | 'trigger');
    res.json({ ddl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(message.includes('No DDL returned') ? 404 : 400).json({ error: message });
  }
};

import type { RequestHandler } from 'express';
import { getDriver } from '../db.js';

export const postQuery: RequestHandler = async (req, res) => {
  const { sql, schema } = req.body as { sql: string; schema?: string };

  if (!sql?.trim()) {
    res.status(400).json({ error: 'sql is required.' });
    return;
  }

  try {
    const start = Date.now();
    const result = await getDriver().query(sql, [], schema);
    const executionTime = Date.now() - start;

    if (result.columnMeta.length === 0) {
      res.json({
        columns: [],
        rows: [],
        affectedRows: result.affectedRows ?? 0,
        insertId: result.insertId ?? null,
        executionTime,
      });
      return;
    }

    res.json({
      columns: result.columnMeta.map(c => c.name),
      columnMeta: result.columnMeta,
      rows: result.rows,
      executionTime,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

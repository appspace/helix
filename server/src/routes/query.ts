import type { RequestHandler } from 'express';
import { getDriver } from '../db.js';

export const postQuery: RequestHandler = async (req, res) => {
  const driver = getDriver();
  const { sql, mql, schema } = req.body as {
    sql?: unknown;
    mql?: unknown;
    schema?: string;
  };

  let queryText: string;

  if (driver.queryMode === 'sql') {
    if (mql !== undefined) {
      res.status(400).json({
        error: 'This connection is in SQL mode; expected a "sql" string body, not a MQL request.',
      });
      return;
    }
    if (typeof sql !== 'string' || !sql.trim()) {
      res.status(400).json({ error: 'sql is required.' });
      return;
    }
    queryText = sql;
  } else {
    // mql mode
    if (typeof sql === 'string') {
      res.status(400).json({
        error: 'This connection is in MQL mode; expected a "mql" object body, not a SQL string.',
      });
      return;
    }
    if (!mql || typeof mql !== 'object') {
      res.status(400).json({ error: 'mql request object is required.' });
      return;
    }
    queryText = JSON.stringify(mql);
  }

  try {
    const start = Date.now();
    const result = await driver.query(queryText, [], schema);
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

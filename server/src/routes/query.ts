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

  // Both `sql` and `mql` present is treated as a mode mismatch — the client is
  // clearly confused about the connection mode, and we'd rather 400 than silently
  // pick one. The mismatch check therefore runs before the "field is required" check.
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
    if (mql === null || typeof mql !== 'object' || Array.isArray(mql)) {
      res.status(400).json({ error: 'mql request object is required.' });
      return;
    }
    queryText = JSON.stringify(mql);
  }

  try {
    const start = Date.now();
    // sql-mode drivers expose `queryAll` for multi-statement support; mql-mode
    // payloads are always a single request and use `query`.
    const resultList = driver.queryMode === 'sql' && driver.queryAll
      ? await driver.queryAll(queryText, schema)
      : [await driver.query(queryText, [], schema)];
    const executionTime = Date.now() - start;

    const results = resultList.map(r => ({
      columns: r.columnMeta.map(c => c.name),
      columnMeta: r.columnMeta,
      rows: r.rows,
      affectedRows: r.affectedRows ?? 0,
      insertId: r.insertId ?? null,
    }));

    // Backwards-compatible single-result envelope: every existing client field is
    // still set from the first result, plus a new `results` array carrying every
    // statement's rows when more than one was sent.
    const first = results[0] ?? { columns: [], columnMeta: [], rows: [], affectedRows: 0, insertId: null };
    res.json({
      columns: first.columns,
      columnMeta: first.columnMeta,
      rows: first.rows,
      affectedRows: first.affectedRows,
      insertId: first.insertId,
      results,
      executionTime,
    });
  } catch (err) {
    // All driver errors map to 400 today — lossy for transient/infra failures
    // (e.g. MongoServerSelectionError, MongoNetworkError, connection drops).
    // See #122 for the proposed classification (client / transient / server).
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

import type { RequestHandler } from 'express';
import { getActiveConfig, getDriver } from '../db.js';

export const postExplain: RequestHandler = async (req, res) => {
  const driver = getDriver();
  const config = getActiveConfig();
  const { sql, schema } = req.body as { sql?: unknown; schema?: string };

  if (driver.queryMode !== 'sql') {
    res.status(400).json({ error: 'EXPLAIN is only supported on SQL connections.' });
    return;
  }
  if (typeof sql !== 'string' || !sql.trim()) {
    res.status(400).json({ error: 'sql is required.' });
    return;
  }
  if (config?.type !== 'mysql') {
    res.status(400).json({ error: 'EXPLAIN visualization is currently only available for MySQL.' });
    return;
  }

  // MySQL rejects EXPLAIN on a multi-statement payload and bare trailing
  // semicolons, so strip one before wrapping. Multi-statement input is rare
  // here (the route is fed by a single editor selection); if a user sends
  // multiple, the driver returns a syntax error which we surface as 400.
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const explainSql = `EXPLAIN FORMAT=JSON ${trimmed}`;

  try {
    const start = Date.now();
    const result = await driver.query(explainSql, [], schema);
    const executionTime = Date.now() - start;

    // MySQL returns one row with one column whose value is the plan JSON as a
    // string. Driver-level serialization keeps it as-is, so parse here so the
    // client always receives a structured tree.
    const row = result.rows[0];
    const value = row ? Object.values(row)[0] : null;
    let plan: unknown = null;
    if (typeof value === 'string') {
      try { plan = JSON.parse(value); }
      catch { plan = value; }
    } else if (value !== undefined) {
      plan = value;
    }

    res.json({ plan, explainSql, executionTime });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

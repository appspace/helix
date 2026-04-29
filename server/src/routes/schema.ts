import type { RequestHandler } from 'express';
import { getDriver } from '../db.js';

export const getSchemas: RequestHandler = async (_req, res) => {
  try {
    const schemas = await getDriver().getSchemas();
    res.json({ schemas });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
};

export const getSchema: RequestHandler = async (req, res) => {
  const schema = req.query['schema'] as string;
  if (!schema?.trim()) {
    res.status(400).json({ error: 'schema query param is required.' });
    return;
  }

  try {
    const info = await getDriver().getSchema(schema);
    res.json(info);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
};

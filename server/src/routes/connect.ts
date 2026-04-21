import type { RequestHandler } from 'express';
import { connect, disconnect, isConnected, getActiveConfig } from '../db.js';

export const postConnect: RequestHandler = async (req, res) => {
  const { host, port, user, password, database, ssl } = req.body as {
    host: string;
    port: number;
    user: string;
    password: string;
    database?: string;
    ssl?: boolean;
  };

  if (!host || !user) {
    res.status(400).json({ error: 'host and user are required.' });
    return;
  }

  try {
    await connect({ host, port: Number(port) || 3306, user, password, database, ssl });
    res.json({ ok: true, connectionName: `${user}@${host}:${port || 3306}` });
  } catch (err) {
    const e = err as { message?: string; code?: string; errno?: number };
    const parts = [e?.message, e?.code && `(${e.code})`].filter(Boolean);
    const message = parts.join(' ').trim() || String(err) || 'Unknown connection error';
    res.status(400).json({ error: message });
  }
};

export const deleteConnect: RequestHandler = async (_req, res) => {
  await disconnect();
  res.json({ ok: true });
};

export const getStatus: RequestHandler = (_req, res) => {
  const config = getActiveConfig();
  res.json({
    connected: isConnected(),
    connectionName: config
      ? `${config.user}@${config.host}:${config.port}`
      : null,
  });
};

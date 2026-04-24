import type { RequestHandler } from 'express';
import { isConnected } from '../db.js';
import { isMcpWritesAllowed, setMcpWritesAllowed } from '../mcp-state.js';

export const getMcpStatus: RequestHandler = (req, res) => {
  const host = req.get('host') ?? `localhost:${process.env['PORT'] ?? 3001}`;
  const protocol = req.protocol ?? 'http';
  res.json({
    connected: isConnected(),
    writesAllowed: isMcpWritesAllowed(),
    mcpUrl: `${protocol}://${host}/mcp`,
  });
};

export const postMcpWrites: RequestHandler = (req, res) => {
  const { enabled } = req.body as { enabled?: unknown };
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: '`enabled` (boolean) is required.' });
    return;
  }
  if (enabled && !isConnected()) {
    res.status(409).json({ error: 'Cannot enable MCP writes without an active database connection.' });
    return;
  }
  setMcpWritesAllowed(enabled);
  res.json({ writesAllowed: isMcpWritesAllowed() });
};

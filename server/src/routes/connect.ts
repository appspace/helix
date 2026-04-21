import type { RequestHandler } from 'express';
import { connect, disconnect, isConnected, getActiveConfig } from '../db.js';

interface MySQLError {
  message?: string;
  code?: string;
  errno?: number;
  address?: string;
  port?: number;
  sqlMessage?: string;
}

function friendlyConnectError(err: unknown, host: string, port: number): string {
  const e = err as MySQLError;
  const code = e?.code;
  const where = `${host}:${port}`;
  const byCode: Record<string, string> = {
    ECONNREFUSED:            `Couldn't reach MySQL at ${where}. Make sure the server is running and the port is open.`,
    ETIMEDOUT:               `Timed out connecting to ${where}. Check the host, port, and any firewall or VPN between you and the server.`,
    ENOTFOUND:               `Unknown host '${host}'. Check the hostname for typos.`,
    EHOSTUNREACH:            `Host '${host}' is unreachable. Check your network, VPN, or firewall rules.`,
    ENETUNREACH:             `Network is unreachable. Check your internet connection or VPN.`,
    ECONNRESET:              `Connection to ${where} was reset. The server may have dropped the connection — verify it's a MySQL server and try again.`,
    EADDRNOTAVAIL:           `Can't bind a local address to reach ${where}. Check your network configuration.`,
    ER_ACCESS_DENIED_ERROR:  `Access denied. Check the username and password.`,
    ER_DBACCESS_DENIED_ERROR:`The user doesn't have access to the selected default schema.`,
    ER_BAD_DB_ERROR:         `The default schema doesn't exist on this server.`,
    ER_HOST_NOT_PRIVILEGED:  `This host isn't allowed to connect to the MySQL server.`,
    ER_NOT_SUPPORTED_AUTH_MODE: `Authentication mode isn't supported by your MySQL client. The server may require a different auth plugin (e.g. caching_sha2_password).`,
    HANDSHAKE_NO_SSL_SUPPORT:`The MySQL server doesn't support SSL/TLS. Turn off "Use SSL / TLS" and try again.`,
    PROTOCOL_CONNECTION_LOST:`Lost connection to the MySQL server during the handshake.`,
  };

  const friendly = code && byCode[code];
  const raw = (e?.sqlMessage?.trim() || e?.message?.trim() || '').trim();
  if (friendly) return code ? `${friendly} (${code})` : friendly;
  if (raw && code) return `${raw} (${code})`;
  if (raw) return raw;
  if (code) return `(${code})`;
  return 'Unknown connection error.';
}

export { friendlyConnectError };

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
    const effectivePort = Number(port) || 3306;
    await connect({ host, port: effectivePort, user, password, database, ssl });
    res.json({ ok: true, connectionName: `${user}@${host}:${effectivePort}` });
  } catch (err) {
    res.status(400).json({ error: friendlyConnectError(err, host, Number(port) || 3306) });
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

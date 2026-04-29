import type { RequestHandler } from 'express';
import type { ConnectionConfig } from '../drivers/interface.js';
import { connect, disconnect, isConnected, getActiveConfig, testConnection } from '../db.js';

type DbType = 'mysql' | 'postgres' | 'mongodb';

function defaultPort(type: DbType): number {
  if (type === 'postgres') return 5432;
  if (type === 'mongodb') return 27017;
  return 3306;
}

interface ConnectError {
  message?: string;
  code?: string;
  codeName?: string;
  errno?: number;
  address?: string;
  port?: number;
  sqlMessage?: string;
}

function friendlyConnectError(err: unknown, host: string, port: number, type: DbType): string {
  const e = err as ConnectError;
  // Prefer the semantic `codeName` (e.g. 'AuthenticationFailed') when the driver
  // surfaces both: MongoDB's numeric `code` (18) isn't in `byCode` and would
  // otherwise mask the semantic match.
  const code = e?.codeName ?? e?.code;
  const where = `${host}:${port}`;

  const byCode: Record<string, string> = {
    // Network errors (shared)
    ECONNREFUSED:  `Couldn't reach the database at ${where}. Make sure the server is running and the port is open.`,
    ETIMEDOUT:     `Timed out connecting to ${where}. Check the host, port, and any firewall or VPN between you and the server.`,
    ENOTFOUND:     `Unknown host '${host}'. Check the hostname for typos.`,
    EHOSTUNREACH:  `Host '${host}' is unreachable. Check your network, VPN, or firewall rules.`,
    ENETUNREACH:   `Network is unreachable. Check your internet connection or VPN.`,
    ECONNRESET:    `Connection to ${where} was reset. The server may have dropped the connection — verify it's a database server and try again.`,
    EADDRNOTAVAIL: `Can't bind a local address to reach ${where}. Check your network configuration.`,
    // MySQL error codes
    ER_ACCESS_DENIED_ERROR:     `Access denied. Check the username and password.`,
    ER_DBACCESS_DENIED_ERROR:   `The user doesn't have access to the selected default schema.`,
    ER_BAD_DB_ERROR:            `The default schema doesn't exist on this server.`,
    ER_HOST_NOT_PRIVILEGED:     `This host isn't allowed to connect to the server.`,
    ER_NOT_SUPPORTED_AUTH_MODE: `Authentication mode isn't supported. The server may require a different auth plugin.`,
    HANDSHAKE_NO_SSL_SUPPORT:   `The server doesn't support SSL/TLS. Turn off "Use SSL / TLS" and try again.`,
    PROTOCOL_CONNECTION_LOST:   `Lost connection to the server during the handshake.`,
    // Postgres error codes
    '28P01': `Access denied. Check the username and password.`,
    '3D000': `The default schema (database) doesn't exist on this server.`,
    '42501': `The user doesn't have permission to connect.`,
    '28000': `Authentication failed. Check the username and password.`,
    '08006': `Connection to the server failed.`,
    // MongoDB error codes (codeName). HostUnreachable / InvalidURI aren't
    // listed: an unreachable host surfaces as MongoServerSelectionError wrapping
    // ENOTFOUND/ECONNREFUSED/ETIMEDOUT (already mapped above), and a malformed
    // URI throws MongoParseError synchronously with no codeName.
    AuthenticationFailed: `Access denied. Check the username and password.`,
  };

  const friendly = code && byCode[code];
  const raw = (e?.sqlMessage?.trim() || e?.message?.trim() || '').trim();
  if (friendly) return code ? `${friendly} (${code})` : friendly;
  if (raw && code) return `${raw} (${code})`;
  if (raw) return raw;
  if (code) return `(${code})`;
  const label = type === 'postgres' ? 'PostgreSQL' : type === 'mongodb' ? 'MongoDB' : 'MySQL';
  return `Unknown connection error connecting to ${label}.`;
}

export { friendlyConnectError };

type ConnectBody = {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: 'require' | 'verify-full';
  type?: unknown;
  connectionString?: string;
};

function parseConnectBody(body: ConnectBody): { config: ConnectionConfig } | { error: string } {
  const { host, port, user, password, database, ssl, type, connectionString } = body;

  if (type !== undefined && type !== 'mysql' && type !== 'postgres' && type !== 'mongodb') {
    return { error: `Unsupported db type: ${String(type)}` };
  }
  if (connectionString && (user || password)) {
    // Strict UX: the URI carries its own credentials; don't silently drop the
    // form fields, and don't silently let them override what's in the URI.
    return { error: 'Provide either connectionString or user/password, not both.' };
  }
  if (!connectionString && (!host || !user)) {
    return { error: 'host and user are required.' };
  }

  const dbType: DbType = (type as DbType | undefined) ?? 'mysql';
  const effectivePort = Number(port) || defaultPort(dbType);
  const config: ConnectionConfig = {
    host: host ?? '',
    port: effectivePort,
    user: user ?? '',
    password: password ?? '',
    database,
    ssl,
    type: dbType,
    ...(connectionString ? { connectionString } : {}),
  };
  return { config };
}

/**
 * Derive a display label like `user@host:port`. When `connectionString` is set
 * the host/port/user fields in `config` are ignored by the driver, so we parse
 * the URI to avoid showing stale form values. Falls back to the URI scheme tag
 * if the URI can't be parsed (e.g. `mongodb+srv://` in older Node URL impls).
 */
function connectionLabel(config: ConnectionConfig): string {
  if (config.connectionString) {
    try {
      // URL doesn't natively understand mongodb+srv; rewrite the scheme so the
      // parser populates host/username. Strip the password from display.
      const isSrv = /^mongodb\+srv:\/\//.test(config.connectionString);
      const normalized = config.connectionString.replace(/^mongodb\+srv:\/\//, 'mongodb://');
      const url = new URL(normalized);
      const user = decodeURIComponent(url.username);
      const host = url.hostname || '<connectionString>';
      const at = user ? `${user}@` : '';
      // For SRV URIs the real port comes from DNS resolution, so we omit it.
      // For plain URIs we only show a port if the URI carries one explicitly.
      if (isSrv || !url.port) return `${at}${host}`;
      return `${at}${host}:${url.port}`;
    } catch {
      return '<connectionString>';
    }
  }
  return `${config.user}@${config.host}:${config.port}`;
}

export const postConnect: RequestHandler = async (req, res) => {
  const parsed = parseConnectBody(req.body as ConnectBody);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { config } = parsed;

  try {
    await connect(config);
    res.json({ ok: true, connectionName: connectionLabel(config) });
  } catch (err) {
    res.status(400).json({ error: friendlyConnectError(err, config.host, config.port, config.type) });
  }
};

export const deleteConnect: RequestHandler = async (_req, res) => {
  await disconnect();
  res.json({ ok: true });
};

export const postTestConnect: RequestHandler = async (req, res) => {
  const parsed = parseConnectBody(req.body as ConnectBody);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { config } = parsed;

  try {
    await testConnection(config);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: friendlyConnectError(err, config.host, config.port, config.type) });
  }
};

export const getStatus: RequestHandler = (_req, res) => {
  const config = getActiveConfig();
  res.json({
    connected: isConnected(),
    connectionName: config ? connectionLabel(config) : null,
  });
};

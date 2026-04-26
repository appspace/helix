import mysql from 'mysql2/promise';
import type { PoolConnection } from 'mysql2/promise';
import { resetMcpState } from './mcp-state.js';

interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  ssl?: boolean;
}

let pool: mysql.Pool | null = null;
let activeConfig: ConnectionConfig | null = null;

export async function connect(config: ConnectionConfig): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  resetMcpState();

  pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database || undefined,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10_000,
  });

  // Verify the connection is reachable
  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();

  activeConfig = config;
}

export async function disconnect(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    activeConfig = null;
  }
  resetMcpState();
}

export function getPool(): mysql.Pool {
  if (!pool) throw new Error('Not connected to any MySQL server.');
  return pool;
}

export function getActiveConfig(): ConnectionConfig | null {
  return activeConfig;
}

export function isConnected(): boolean {
  return pool !== null;
}

// Acquires a single connection, optionally switches schema, runs fn, then releases.
// Guarantees USE and the subsequent query land on the same connection.
export async function withSchema<T>(
  schema: string | undefined,
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    if (schema) await conn.query(`USE \`${schema.replace(/`/g, '')}\``);
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function testConnection(config: ConnectionConfig): Promise<void> {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database || undefined,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 10_000,
  });
  try {
    await conn.ping();
  } finally {
    await conn.end();
  }
}

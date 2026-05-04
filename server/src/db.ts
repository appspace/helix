import { resetMcpState } from './mcp-state.js';
import { MysqlDriver } from './drivers/mysql.js';
import { PostgresDriver } from './drivers/postgres.js';
import { MongoDBDriver } from './drivers/mongodb.js';
import type { DbDriver, ConnectionConfig } from './drivers/interface.js';

let driver: DbDriver | null = null;
let activeConfig: ConnectionConfig | null = null;

function makeDriver(config: ConnectionConfig): DbDriver {
  switch (config.type) {
    case 'postgres':
      return new PostgresDriver(config);
    case 'mongodb':
      return new MongoDBDriver(config);
    default:
      return new MysqlDriver(config);
  }
}

export async function connect(config: ConnectionConfig): Promise<void> {
  if (driver) {
    await driver.end();
    driver = null;
  }
  resetMcpState();

  const d = makeDriver(config);
  await d.ping();
  driver = d;
  activeConfig = config;
}

export async function disconnect(): Promise<void> {
  if (driver) {
    await driver.end();
    driver = null;
    activeConfig = null;
  }
  resetMcpState();
}

export function getDriver(): DbDriver {
  if (!driver) throw new Error('Not connected to any database.');
  return driver;
}

export function getActiveConfig(): ConnectionConfig | null {
  return activeConfig;
}

export function isConnected(): boolean {
  return driver !== null;
}

/**
 * Drop and rebuild the active driver's connection pool. Idempotent — no-op when
 * not connected or when the driver doesn't pool. Used by the resume-from-sleep
 * path so the next query opens a fresh socket; the user-facing connection state
 * is preserved (no UI logout).
 */
export async function recycleActivePool(): Promise<void> {
  if (driver?.recyclePool) {
    await driver.recyclePool();
  }
}

export async function testConnection(config: ConnectionConfig): Promise<void> {
  const d = makeDriver(config);
  try {
    await d.ping();
  } finally {
    await d.end();
  }
}

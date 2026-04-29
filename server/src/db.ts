import { resetMcpState } from './mcp-state.js';
import { MysqlDriver } from './drivers/mysql.js';
import { PostgresDriver } from './drivers/postgres.js';
import type { DbDriver, ConnectionConfig } from './drivers/interface.js';

let driver: DbDriver | null = null;
let activeConfig: ConnectionConfig | null = null;

function makeDriver(config: ConnectionConfig): DbDriver {
  return config.type === 'postgres' ? new PostgresDriver(config) : new MysqlDriver(config);
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

export async function testConnection(config: ConnectionConfig): Promise<void> {
  const d = makeDriver(config);
  try {
    await d.ping();
  } finally {
    await d.end();
  }
}

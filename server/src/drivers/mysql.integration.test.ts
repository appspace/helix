import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MysqlDriver } from './mysql.js';

// Points at the throwaway mysql-test container from docker-compose.yml, seeded
// by src/test-setup/global-setup.ts.
const MYSQL_CONFIG = {
  host: process.env['MYSQL_HOST'] ?? 'localhost',
  port: Number(process.env['MYSQL_PORT'] ?? 13306),
  user: process.env['MYSQL_USER'] ?? 'root',
  password: process.env['MYSQL_PASSWORD'] ?? 'root',
  database: process.env['MYSQL_DB'] ?? 'helix_test',
  type: 'mysql' as const,
};

let driver: MysqlDriver;

beforeAll(() => {
  driver = new MysqlDriver(MYSQL_CONFIG);
});

afterAll(async () => {
  await driver.end();
});

// ---------------------------------------------------------------------------
// getSchema / getTable – indexes
// ---------------------------------------------------------------------------

describe('MysqlDriver – index metadata', () => {
  it('reports the primary key as a unique index', async () => {
    const info = await driver.getSchema('helix_test');
    const users = info.tables.find(t => t.name === 'users')!;
    const primary = users.indexes.find(i => i.name === 'PRIMARY')!;
    expect(primary.unique).toBe(true);
    expect(primary.columns).toEqual(['id']);
    expect(primary.type).toBe('BTREE');
  });

  it('reports composite index columns in index order', async () => {
    const info = await driver.getSchema('helix_test');
    const orders = info.tables.find(t => t.name === 'orders')!;
    const composite = orders.indexes.find(i => i.name === 'idx_orders_user_created')!;
    expect(composite.columns).toEqual(['user_id', 'created_at']);
    expect(composite.unique).toBe(false);
  });

  it('reports one entry per index, not per indexed column', async () => {
    const info = await driver.getSchema('helix_test');
    const orders = info.tables.find(t => t.name === 'orders')!;
    expect(orders.indexes.map(i => i.name).sort()).toEqual(
      ['PRIMARY', 'idx_orders_user_created', 'idx_orders_user_id'],
    );
  });

  it('getTable returns the same indexes as getSchema for that table', async () => {
    const info = await driver.getSchema('helix_test');
    const fromSchema = info.tables.find(t => t.name === 'orders')!.indexes;
    const fromTable = (await driver.getTable('helix_test', 'orders'))!.indexes;
    expect(fromTable).toEqual(fromSchema);
  });
});

// ---------------------------------------------------------------------------
// getSchema / getTable – foreign keys
// ---------------------------------------------------------------------------

describe('MysqlDriver – foreign key metadata', () => {
  it('reports the referencing and referenced sides of a foreign key', async () => {
    const info = await driver.getSchema('helix_test');
    const orders = info.tables.find(t => t.name === 'orders')!;
    expect(orders.foreignKeys).toEqual([
      {
        name: 'fk_orders_user',
        columns: ['user_id'],
        referencedSchema: 'helix_test',
        referencedTable: 'users',
        referencedColumns: ['id'],
      },
    ]);
  });

  it('reports no foreign keys on the referenced table itself', async () => {
    const info = await driver.getSchema('helix_test');
    expect(info.tables.find(t => t.name === 'users')!.foreignKeys).toEqual([]);
  });

  it('getTable returns the same foreign keys as getSchema for that table', async () => {
    const info = await driver.getSchema('helix_test');
    const fromSchema = info.tables.find(t => t.name === 'orders')!.foreignKeys;
    const fromTable = (await driver.getTable('helix_test', 'orders'))!.foreignKeys;
    expect(fromTable).toEqual(fromSchema);
  });
});

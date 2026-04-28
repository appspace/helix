import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresDriver } from './postgres.js';

const PG_CONFIG = {
  host: process.env['PG_HOST'] ?? 'localhost',
  port: Number(process.env['PG_PORT'] ?? 5433),
  user: process.env['PG_USER'] ?? 'root',
  password: process.env['PG_PASSWORD'] ?? 'root',
  database: process.env['PG_DB'] ?? 'helix_test',
  type: 'postgres' as const,
};

let driver: PostgresDriver;
let raw: pg.Client;

beforeAll(async () => {
  driver = new PostgresDriver(PG_CONFIG);
  raw = new pg.Client(PG_CONFIG);
  await raw.connect();
});

afterAll(async () => {
  await raw.end();
  await driver.end();
});

beforeEach(async () => {
  await raw.query('DELETE FROM orders');
  await raw.query('DELETE FROM users');
  await raw.query("SELECT setval('users_id_seq', 1, false)");
  await raw.query("SELECT setval('orders_id_seq', 1, false)");
});

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

describe('PostgresDriver – ping', () => {
  it('resolves without error when connected', async () => {
    await expect(driver.ping()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// escapeIdent
// ---------------------------------------------------------------------------

describe('PostgresDriver – escapeIdent', () => {
  it('wraps identifier in double-quotes', () => {
    expect(driver.escapeIdent('my_table')).toBe('"my_table"');
  });

  it('strips embedded double-quotes to prevent injection', () => {
    expect(driver.escapeIdent('bad"name')).toBe('"badname"');
  });
});

// ---------------------------------------------------------------------------
// query – SELECT
// ---------------------------------------------------------------------------

describe('PostgresDriver – query (SELECT)', () => {
  it('returns empty rows for an empty table', async () => {
    const result = await driver.query('SELECT * FROM users', [], 'public');
    expect(result.rows).toEqual([]);
    expect(result.columnMeta.map(c => c.name)).toContain('id');
  });

  it('returns inserted rows with correct types', async () => {
    await raw.query("INSERT INTO users (name, age) VALUES ('Alice', 30)");
    const result = await driver.query('SELECT id, name, age FROM users', [], 'public');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ name: 'Alice', age: 30 });
  });

  it('switches schema via SET search_path when schema is provided', async () => {
    await raw.query("INSERT INTO users (name) VALUES ('Bob')");
    const result = await driver.query('SELECT name FROM users', [], 'public');
    expect(result.rows[0]).toMatchObject({ name: 'Bob' });
  });

  it('runs the query without schema switching when schema is omitted', async () => {
    const result = await driver.query('SELECT 1 AS one');
    expect(result.rows[0]).toMatchObject({ one: 1 });
  });

  it('serializes NULL as null', async () => {
    await raw.query("INSERT INTO users (name, age) VALUES ('Carol', NULL)");
    const result = await driver.query('SELECT age FROM users');
    expect(result.rows[0]!['age']).toBeNull();
  });

  it('serializes Date columns as ISO-style strings without milliseconds', async () => {
    await raw.query("INSERT INTO users (name) VALUES ('Dave')");
    await raw.query("INSERT INTO orders (user_id, total) VALUES (1, 9.99)");
    const result = await driver.query('SELECT created_at FROM orders');
    const val = result.rows[0]!['created_at'] as string;
    expect(val).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('populates columnMeta with correct names', async () => {
    const result = await driver.query('SELECT id, name FROM users');
    expect(result.columnMeta.map(c => c.name)).toEqual(['id', 'name']);
  });
});

// ---------------------------------------------------------------------------
// query – DML
// ---------------------------------------------------------------------------

describe('PostgresDriver – query (DML)', () => {
  it('returns affectedRows for an UPDATE statement', async () => {
    await raw.query("INSERT INTO users (name, age) VALUES ('Eve', 25), ('Frank', 25)");
    const result = await driver.query("UPDATE users SET age = 26 WHERE age = 25");
    expect(result.rows).toEqual([]);
    expect(result.affectedRows).toBe(2);
  });

  it('returns 0 affectedRows when WHERE matches nothing', async () => {
    const result = await driver.query("UPDATE users SET age = 99 WHERE id = 9999");
    expect(result.affectedRows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getSchemas
// ---------------------------------------------------------------------------

describe('PostgresDriver – getSchemas', () => {
  it('returns user schemas and excludes system schemas', async () => {
    const schemas = await driver.getSchemas();
    expect(schemas).toContain('public');
    expect(schemas).not.toContain('pg_catalog');
    expect(schemas).not.toContain('information_schema');
    expect(schemas.every(s => !s.startsWith('pg_toast'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getSchema
// ---------------------------------------------------------------------------

describe('PostgresDriver – getSchema', () => {
  it('returns tables with name and column info', async () => {
    const info = await driver.getSchema('public');
    const users = info.tables.find(t => t.name === 'users');
    expect(users).toBeDefined();
    const idCol = users!.columns.find(c => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.pk).toBe(true);
    expect(idCol!.autoIncrement).toBe(true);
    const nameCol = users!.columns.find(c => c.name === 'name');
    expect(nameCol!.nullable).toBe(false);
  });

  it('includes the orders table with a numeric total column', async () => {
    const info = await driver.getSchema('public');
    const orders = info.tables.find(t => t.name === 'orders');
    expect(orders).toBeDefined();
    const totalCol = orders!.columns.find(c => c.name === 'total');
    expect(totalCol).toBeDefined();
    expect(totalCol!.dataType).toMatch(/numeric|decimal/i);
  });

  it('row_count is a number (estimated from pg_stat_user_tables)', async () => {
    const info = await driver.getSchema('public');
    for (const t of info.tables) {
      expect(typeof t.rows).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// getTableDdl
// ---------------------------------------------------------------------------

describe('PostgresDriver – getTableDdl', () => {
  it('reconstructs CREATE TABLE with columns and primary key', async () => {
    const ddl = await driver.getTableDdl('public', 'users', 'table');
    expect(ddl).toMatch(/CREATE TABLE/i);
    expect(ddl).toMatch(/"users"/);
    expect(ddl).toMatch(/PRIMARY KEY/i);
    expect(ddl).toMatch(/"id"/);
    expect(ddl).toMatch(/"name"/);
  });

  it('includes non-PK index in the reconstructed DDL', async () => {
    const ddl = await driver.getTableDdl('public', 'orders', 'table');
    expect(ddl).toMatch(/idx_orders_user_id/);
  });

  it('throws for a non-existent table', async () => {
    await expect(driver.getTableDdl('public', 'ghost_table', 'table')).rejects.toThrow();
  });
});

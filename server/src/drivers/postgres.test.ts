import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

class MockPool {
  connect = vi.fn(() => Promise.resolve(mockClient));
  query = vi.fn();
  end = vi.fn();
}
const mockPoolInstance = new MockPool();

const { setTypeParser } = vi.hoisted(() => ({ setTypeParser: vi.fn() }));

vi.mock('pg', () => ({
  default: {
    // vitest 4 constructs through the mock implementation, so `new pg.Pool()`
    // needs a real `function` here — an arrow is not a constructor.
    Pool: vi.fn(function () { return mockPoolInstance; }),
    types: { setTypeParser },
  },
}));

import { PostgresDriver } from './postgres.js';
import { DriverError } from './interface.js';

// Snapshot module-load `setTypeParser` calls before any `vi.clearAllMocks()`
// in later `beforeEach` blocks wipes them.
const initialTypeParserCalls = setTypeParser.mock.calls.map(c => [c[0], c[1]] as const);

function makeDriver() {
  return new PostgresDriver({
    host: 'h', port: 5432, user: 'u', password: 'p', type: 'postgres',
  });
}

describe('PostgresDriver.query – connection release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolInstance.connect.mockResolvedValue(mockClient);
  });

  it('releases the client on success', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 1 }], fields: [{ name: 'id' }], rowCount: 1 });
    await makeDriver().query('SELECT 1');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('releases the client when query rejects', async () => {
    mockClient.query.mockRejectedValueOnce(new Error('boom'));
    await expect(makeDriver().query('SELECT 1')).rejects.toThrow('boom');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('releases the client when SET search_path rejects', async () => {
    mockClient.query.mockRejectedValueOnce(new Error('bad schema'));
    await expect(makeDriver().query('SELECT 1', [], 'ghost')).rejects.toThrow('bad schema');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('resets search_path before release when a schema was set', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // SET search_path TO ghost
      .mockResolvedValueOnce({ rows: [], fields: [], rowCount: 0 }); // user query
    await makeDriver().query('SELECT 1', [], 'ghost');
    const calls = mockClient.query.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : c[0].text));
    expect(calls).toContain('SET search_path TO DEFAULT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('resets search_path even when the user query rejects', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // SET search_path TO ghost
      .mockRejectedValueOnce(new Error('boom')); // user query
    await expect(makeDriver().query('SELECT 1', [], 'ghost')).rejects.toThrow('boom');
    const calls = mockClient.query.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : c[0].text));
    expect(calls).toContain('SET search_path TO DEFAULT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('PostgresDriver.query – error classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolInstance.connect.mockResolvedValue(mockClient);
  });

  function pgError(message: string, code: string): Error {
    const err = new Error(message);
    (err as Record<string, unknown>).code = code;
    return err;
  }

  it('wraps a syntax error (42xxx) as a client DriverError', async () => {
    mockClient.query.mockRejectedValueOnce(pgError('syntax error at or near "SELEC"', '42601'));
    await expect(makeDriver().query('SELEC 1')).rejects.toMatchObject({
      errorClass: 'client',
      message: 'syntax error at or near "SELEC"',
    });
  });

  it('wraps a connection error (08xxx) as a transient DriverError', async () => {
    mockClient.query.mockRejectedValueOnce(pgError('connection refused', '08006'));
    await expect(makeDriver().query('SELECT 1')).rejects.toMatchObject({
      errorClass: 'transient',
    });
  });

  it('wraps a resource error (53xxx) as a transient DriverError', async () => {
    mockClient.query.mockRejectedValueOnce(pgError('too many connections', '53300'));
    await expect(makeDriver().query('SELECT 1')).rejects.toMatchObject({
      errorClass: 'transient',
    });
  });

  it('wraps an operator-intervention error (57xxx) as a transient DriverError', async () => {
    mockClient.query.mockRejectedValueOnce(pgError('canceling statement due to user request', '57014'));
    await expect(makeDriver().query('SELECT 1')).rejects.toMatchObject({
      errorClass: 'transient',
    });
  });

  it('wraps an unrecognized pg error as a server DriverError', async () => {
    mockClient.query.mockRejectedValueOnce(pgError('some internal error', 'XX000'));
    await expect(makeDriver().query('SELECT 1')).rejects.toMatchObject({
      errorClass: 'server',
    });
  });

  it('re-throws DriverError instances without double-wrapping', async () => {
    const original = new DriverError('already classified', 'client');
    mockClient.query.mockRejectedValueOnce(original);
    const thrown = await makeDriver().query('SELECT 1').catch(e => e);
    expect(thrown).toBe(original);
  });
});

describe('PostgresDriver.recyclePool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // recyclePool fire-and-forgets `old.end()` via `.catch()`, so the mock has
    // to return a real promise; bare vi.fn() returns undefined.
    mockPoolInstance.end.mockResolvedValue(undefined);
  });

  async function getPoolCtor() {
    const mod = (await import('pg')).default as unknown as { Pool: ReturnType<typeof vi.fn> };
    return mod.Pool;
  }

  it('builds a fresh pool and ends the old one', async () => {
    const Pool = await getPoolCtor();
    const driver = makeDriver();
    expect(Pool).toHaveBeenCalledTimes(1);

    mockPoolInstance.end.mockResolvedValueOnce(undefined);
    await driver.recyclePool();
    expect(Pool).toHaveBeenCalledTimes(2);
    expect(mockPoolInstance.end).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from the old pool — its clients may already be dead', async () => {
    const driver = makeDriver();
    mockPoolInstance.end.mockRejectedValueOnce(new Error('client closed'));
    await expect(driver.recyclePool()).resolves.toBeUndefined();
  });

  it('routes operations after recycle to the new pool, not the old one', async () => {
    const Pool = await getPoolCtor();
    const oldPool = { connect: vi.fn(), query: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
    const newPool = { connect: vi.fn().mockResolvedValue(mockClient), query: vi.fn(), end: vi.fn() };
    Pool.mockImplementationOnce(function () { return oldPool; })
        .mockImplementationOnce(function () { return newPool; });

    const driver = makeDriver();
    await driver.recyclePool();

    const beforeQuery = newPool.connect.mock.calls.length;
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 1 }], fields: [{ name: 'id' }], rowCount: 1 });
    await driver.query('SELECT 1');

    expect(newPool.connect.mock.calls.length).toBeGreaterThan(beforeQuery);
    expect(oldPool.connect).not.toHaveBeenCalled();
  });

  it('pre-warms the new pool so the next user query skips the connect cost', async () => {
    const Pool = await getPoolCtor();
    const newPool = { connect: vi.fn().mockResolvedValue(mockClient), query: vi.fn(), end: vi.fn() };
    Pool.mockImplementationOnce(function () { return mockPoolInstance; })
        .mockImplementationOnce(function () { return newPool; });

    const driver = makeDriver();
    await driver.recyclePool();

    expect(newPool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('coalesces concurrent recycle calls so a duplicate event does not orphan a pool', async () => {
    const Pool = await getPoolCtor();
    Pool.mockImplementation(function () { return mockPoolInstance; });
    mockPoolInstance.end.mockResolvedValue(undefined);
    const driver = makeDriver();
    Pool.mockClear();

    const a = driver.recyclePool();
    const b = driver.recyclePool();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(Pool).toHaveBeenCalledTimes(1);
  });

  it('configures TCP keepalive on the pool', async () => {
    const Pool = await getPoolCtor();
    Pool.mockClear();
    makeDriver();
    expect(Pool).toHaveBeenCalledTimes(1);
    const cfg = Pool.mock.calls[0][0];
    expect(cfg.keepAlive).toBe(true);
    expect(cfg.keepAliveInitialDelayMillis).toBe(10_000);
  });
});

describe('PostgresDriver – date/time type parsers', () => {
  it('overrides DATE/TIME/TIMESTAMP/TIMESTAMPTZ/TIMETZ parsers to return raw strings', () => {
    const oids = initialTypeParserCalls.map(([oid]) => oid);
    // 1082=DATE, 1083=TIME, 1114=TIMESTAMP, 1184=TIMESTAMPTZ, 1266=TIMETZ
    expect(oids).toEqual(expect.arrayContaining([1082, 1083, 1114, 1184, 1266]));

    // Each parser should be the identity for the wire string — no Date conversion.
    for (const [, parser] of initialTypeParserCalls) {
      expect((parser as (v: string) => string)('2026-05-07 10:00:00')).toBe('2026-05-07 10:00:00');
    }
  });
});

describe('PostgresDriver – index metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolInstance.connect.mockResolvedValue(mockClient);
  });

  // One row per (index, column) pair, ordered by index position — the shape
  // `unnest(indkey) WITH ORDINALITY` produces.
  const INDEX_ROWS = [
    { tbl: 'orders', idx: 'orders_pkey', is_unique: true, idx_type: 'btree', col: 'id' },
    { tbl: 'orders', idx: 'orders_tenant_created_idx', is_unique: false, idx_type: 'btree', col: 'tenant_id' },
    { tbl: 'orders', idx: 'orders_tenant_created_idx', is_unique: false, idx_type: 'btree', col: 'created_at' },
    { tbl: 'users', idx: 'users_email_key', is_unique: true, idx_type: 'btree', col: 'email' },
  ];

  // getSchema queries sequentially: tables, columns, indexes, foreign keys,
  // views, routines, triggers.
  function stubGetSchema(indexRows: Record<string, unknown>[]) {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ name: 'orders', row_count: '3' }, { name: 'users', row_count: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: indexRows })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
  }

  it('folds pg_index rows into one index per name, keyed by table', async () => {
    stubGetSchema(INDEX_ROWS);
    const info = await makeDriver().getSchema('public');

    expect(info.tables.find(t => t.name === 'orders')!.indexes).toEqual([
      { name: 'orders_pkey', unique: true, columns: ['id'], type: 'btree' },
      { name: 'orders_tenant_created_idx', unique: false, columns: ['tenant_id', 'created_at'], type: 'btree' },
    ]);
    expect(info.tables.find(t => t.name === 'users')!.indexes).toEqual([
      { name: 'users_email_key', unique: true, columns: ['email'], type: 'btree' },
    ]);
  });

  it('unnests indkey with ordinality so column order survives', async () => {
    stubGetSchema([]);
    await makeDriver().getSchema('public');
    const indexSql = mockClient.query.mock.calls[2][0] as string;
    expect(indexSql).toContain('unnest(ix.indkey::int2[]) WITH ORDINALITY');
    expect(indexSql).toContain('ORDER BY c.relname, i.relname, k.ord');
  });

  it('renders expression index parts (attnum 0, no pg_attribute row) as (expression)', async () => {
    stubGetSchema([
      { tbl: 'orders', idx: 'orders_lower_ref_idx', is_unique: false, idx_type: 'btree', col: null },
    ]);
    const info = await makeDriver().getSchema('public');
    expect(info.tables.find(t => t.name === 'orders')!.indexes[0].columns).toEqual(['(expression)']);
  });

  it('reports the access method for non-btree indexes', async () => {
    stubGetSchema([
      { tbl: 'orders', idx: 'orders_tags_idx', is_unique: false, idx_type: 'gin', col: 'tags' },
    ]);
    const info = await makeDriver().getSchema('public');
    expect(info.tables.find(t => t.name === 'orders')!.indexes[0].type).toBe('gin');
  });

  it('leaves tables with no indexes as an empty list', async () => {
    stubGetSchema([]);
    const info = await makeDriver().getSchema('public');
    expect(info.tables.map(t => t.indexes)).toEqual([[], []]);
  });

  it('getTable returns the indexes of that table only', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ name: 'orders', row_count: '3' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: INDEX_ROWS.filter(r => r.tbl === 'orders') })
      .mockResolvedValueOnce({ rows: [] });
    const table = await makeDriver().getTable('public', 'orders');
    expect(table!.indexes.map(i => i.name)).toEqual(['orders_pkey', 'orders_tenant_created_idx']);
  });
});

describe('PostgresDriver – foreign key metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolInstance.connect.mockResolvedValue(mockClient);
  });

  // One row per (constraint, column) pair, ordered by position within the key.
  const FK_ROWS = [
    { tbl: 'orders', name: 'orders_user_id_fkey', col: 'user_id',
      ref_schema: 'public', ref_tbl: 'users', ref_col: 'id' },
    { tbl: 'order_items', name: 'order_items_order_fkey', col: 'order_tenant',
      ref_schema: 'public', ref_tbl: 'orders', ref_col: 'tenant' },
    { tbl: 'order_items', name: 'order_items_order_fkey', col: 'order_id',
      ref_schema: 'public', ref_tbl: 'orders', ref_col: 'id' },
  ];

  function stubGetSchema(fkRows: Record<string, unknown>[]) {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ name: 'orders', row_count: '3' }, { name: 'order_items', row_count: '9' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: fkRows })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
  }

  it('folds pg_constraint rows into one entry per constraint, keyed by table', async () => {
    stubGetSchema(FK_ROWS);
    const info = await makeDriver().getSchema('public');

    expect(info.tables.find(t => t.name === 'orders')!.foreignKeys).toEqual([
      {
        name: 'orders_user_id_fkey',
        columns: ['user_id'],
        referencedSchema: 'public',
        referencedTable: 'users',
        referencedColumns: ['id'],
      },
    ]);
  });

  it('keeps composite key columns aligned with the columns they reference', async () => {
    stubGetSchema(FK_ROWS);
    const info = await makeDriver().getSchema('public');
    const fk = info.tables.find(t => t.name === 'order_items')!.foreignKeys[0];
    expect(fk.columns).toEqual(['order_tenant', 'order_id']);
    expect(fk.referencedColumns).toEqual(['tenant', 'id']);
  });

  it('unnests conkey and confkey together so composite keys stay paired', async () => {
    stubGetSchema([]);
    await makeDriver().getSchema('public');
    const fkSql = mockClient.query.mock.calls[3][0] as string;
    expect(fkSql).toContain('unnest(con.conkey, con.confkey) WITH ORDINALITY');
    expect(fkSql).toContain("con.contype = 'f'");
    expect(fkSql).toContain('ORDER BY c.relname, con.conname, k.ord');
  });

  it('leaves tables with no foreign keys as an empty list', async () => {
    stubGetSchema([]);
    const info = await makeDriver().getSchema('public');
    expect(info.tables.map(t => t.foreignKeys)).toEqual([[], []]);
  });

  it('getTable returns the foreign keys of that table only', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ name: 'orders', row_count: '3' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: FK_ROWS.filter(r => r.tbl === 'orders') });
    const table = await makeDriver().getTable('public', 'orders');
    expect(table!.foreignKeys.map(f => f.name)).toEqual(['orders_user_id_fkey']);
  });
});

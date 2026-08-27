import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConn = {
  query: vi.fn(),
  ping: vi.fn(),
  release: vi.fn(),
};
const mockPool = {
  getConnection: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
};

vi.mock('mysql2/promise', () => ({
  default: { createPool: vi.fn(() => mockPool) },
}));

import { MysqlDriver } from './mysql.js';

function makeDriver() {
  return new MysqlDriver({
    host: 'h', port: 3306, user: 'u', password: 'p', type: 'mysql',
  });
}

describe('MysqlDriver.query – connection release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.getConnection.mockResolvedValue(mockConn);
  });

  it('releases the connection on success', async () => {
    mockConn.query.mockResolvedValueOnce([[{ id: 1 }], [{ name: 'id' }]]);
    await makeDriver().query('SELECT 1');
    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });

  it('releases the connection when query rejects', async () => {
    mockConn.query.mockRejectedValueOnce(new Error('boom'));
    await expect(makeDriver().query('SELECT 1')).rejects.toThrow('boom');
    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });

  it('releases the connection when USE schema rejects', async () => {
    mockConn.query.mockRejectedValueOnce(new Error('unknown db'));
    await expect(makeDriver().query('SELECT 1', [], 'ghost')).rejects.toThrow('unknown db');
    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });
});

describe('MysqlDriver.recyclePool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.getConnection.mockResolvedValue(mockConn);
    // recyclePool fire-and-forgets `old.end()` via `.catch()`, so the mock has
    // to return a real promise; bare vi.fn() returns undefined.
    mockPool.end.mockResolvedValue(undefined);
  });

  async function getCreatePoolMock() {
    const mod = (await import('mysql2/promise')).default as unknown as { createPool: ReturnType<typeof vi.fn> };
    return mod.createPool;
  }

  // Hand each createPool call a distinct pool instance so a test can assert
  // that operations after recycle target the *new* pool, not the old one.
  async function stubPoolsPerCreate(...pools: typeof mockPool[]) {
    const cp = await getCreatePoolMock();
    let i = 0;
    cp.mockImplementation(() => pools[Math.min(i++, pools.length - 1)]);
  }

  it('builds a fresh pool and ends the old one', async () => {
    const cp = await getCreatePoolMock();
    const driver = makeDriver();
    expect(cp).toHaveBeenCalledTimes(1);

    mockPool.end.mockResolvedValueOnce(undefined);
    await driver.recyclePool();
    expect(cp).toHaveBeenCalledTimes(2);
    expect(mockPool.end).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from the old pool — its sockets may already be dead', async () => {
    const driver = makeDriver();
    mockPool.end.mockRejectedValueOnce(new Error('socket closed'));
    await expect(driver.recyclePool()).resolves.toBeUndefined();
  });

  it('routes operations after recycle to the new pool, not the old one', async () => {
    const oldPool = { ...mockPool, getConnection: vi.fn(), query: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
    const newPool = { ...mockPool, getConnection: vi.fn().mockResolvedValue(mockConn), query: vi.fn(), end: vi.fn() };
    await stubPoolsPerCreate(oldPool, newPool);

    const driver = makeDriver();
    await driver.recyclePool();

    // recyclePool's pre-warm itself takes one connection on the new pool.
    const beforeQuery = newPool.getConnection.mock.calls.length;
    mockConn.query.mockResolvedValueOnce([[{ ok: 1 }], [{ name: 'ok' }]]);
    await driver.query('SELECT 1');

    expect(newPool.getConnection.mock.calls.length).toBeGreaterThan(beforeQuery);
    expect(oldPool.getConnection).not.toHaveBeenCalled();
  });

  it('pre-warms the new pool so the next user query skips the connect cost', async () => {
    const cp = await getCreatePoolMock();
    const newPool = { ...mockPool, getConnection: vi.fn().mockResolvedValue(mockConn), query: vi.fn(), end: vi.fn() };
    cp.mockImplementationOnce(() => mockPool).mockImplementationOnce(() => newPool);

    const driver = makeDriver();
    await driver.recyclePool();

    expect(newPool.getConnection).toHaveBeenCalledTimes(1);
    expect(mockConn.release).toHaveBeenCalled();
  });

  it('coalesces concurrent recycle calls so a duplicate event does not orphan a pool', async () => {
    const cp = await getCreatePoolMock();
    cp.mockImplementation(() => mockPool);
    mockPool.end.mockResolvedValue(undefined);
    const driver = makeDriver();
    cp.mockClear();

    // Two host-resumed events fire before the first recycle settles.
    const a = driver.recyclePool();
    const b = driver.recyclePool();
    expect(a).toBe(b); // same in-flight promise — no second pool built
    await Promise.all([a, b]);
    expect(cp).toHaveBeenCalledTimes(1);
  });

  it('configures TCP keepalive on the pool so post-resume sockets are detected', async () => {
    const cp = await getCreatePoolMock();
    cp.mockClear();
    makeDriver();
    expect(cp).toHaveBeenCalledTimes(1);
    const opts = cp.mock.calls[0][0];
    expect(opts.enableKeepAlive).toBe(true);
    expect(opts.keepAliveInitialDelay).toBe(10_000);
  });

  it('enables dateStrings so DATE/DATETIME/TIMESTAMP avoid the local-TZ JS Date roundtrip', async () => {
    const cp = await getCreatePoolMock();
    cp.mockClear();
    makeDriver();
    const opts = cp.mock.calls[0][0];
    expect(opts.dateStrings).toBe(true);
  });
});

describe('MysqlDriver.queryAll – multi-statement results', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.getConnection.mockResolvedValue(mockConn);
  });

  it('returns one result per statement when mysql2 returns parallel arrays', async () => {
    // mysql2's shape for multi-statement responses: arrays-of-arrays for both rows and fields.
    mockConn.query.mockResolvedValueOnce([
      [
        [{ a: 1 }],
        [{ b: 2 }],
      ],
      [
        [{ name: 'a' }],
        [{ name: 'b' }],
      ],
    ]);
    const results = await makeDriver().queryAll('SELECT 1 AS a; SELECT 2 AS b');
    expect(results).toHaveLength(2);
    expect(results[0].rows).toEqual([{ a: 1 }]);
    expect(results[1].rows).toEqual([{ b: 2 }]);
    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });

  it('wraps a single-statement response in a one-element array', async () => {
    mockConn.query.mockResolvedValueOnce([[{ id: 1 }], [{ name: 'id' }]]);
    const results = await makeDriver().queryAll('SELECT 1 AS id');
    expect(results).toHaveLength(1);
    expect(results[0].rows).toEqual([{ id: 1 }]);
    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });

  it('releases the connection when queryAll rejects', async () => {
    mockConn.query.mockRejectedValueOnce(new Error('multi boom'));
    await expect(makeDriver().queryAll('SELECT 1; SELECT 2')).rejects.toThrow('multi boom');
    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });
});

describe('MysqlDriver.query – BIT column serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.getConnection.mockResolvedValue(mockConn);
  });

  it('returns 0/1 numbers for bit(1) columns instead of hex strings', async () => {
    // mysql2 returns BIT columns as Buffers; type code 16 is MYSQL_TYPE_BIT.
    mockConn.query.mockResolvedValueOnce([
      [
        { flag: Buffer.from([0]) },
        { flag: Buffer.from([1]) },
      ],
      [{ name: 'flag', columnType: 16, flags: 0 }],
    ]);
    const result = await makeDriver().query('SELECT flag FROM t');
    expect(result.rows).toEqual([{ flag: 0 }, { flag: 1 }]);
  });

  it('keeps hex serialization for non-BIT Buffer columns (e.g. binary)', async () => {
    // BLOB type code is 252; should remain hex-encoded.
    mockConn.query.mockResolvedValueOnce([
      [{ data: Buffer.from([0xde, 0xad]) }],
      [{ name: 'data', columnType: 252, flags: 0 }],
    ]);
    const result = await makeDriver().query('SELECT data FROM t');
    expect(result.rows).toEqual([{ data: 'dead' }]);
  });
});

describe('MysqlDriver – index metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.getConnection.mockResolvedValue(mockConn);
  });

  // information_schema.STATISTICS rows, one per (index, column) pair, in the
  // order the driver's ORDER BY produces them.
  const STATISTICS_ROWS = [
    { tbl: 'orders', idx: 'PRIMARY', col: 'id', non_unique: 0, idx_type: 'BTREE' },
    { tbl: 'orders', idx: 'idx_user_created', col: 'user_id', non_unique: 1, idx_type: 'BTREE' },
    { tbl: 'orders', idx: 'idx_user_created', col: 'created_at', non_unique: 1, idx_type: 'BTREE' },
    { tbl: 'users', idx: 'uq_email', col: 'email', non_unique: 0, idx_type: 'BTREE' },
  ];

  // getSchema fires seven queries: tables, columns, indexes, foreign keys,
  // views, procedures, triggers.
  function stubGetSchema(statisticsRows: Record<string, unknown>[]) {
    mockConn.query
      .mockResolvedValueOnce([[
        { name: 'orders', row_count: 3, comment: '' },
        { name: 'users', row_count: 1, comment: '' },
      ]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([statisticsRows])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);
  }

  it('folds STATISTICS rows into one index per name, keyed by table', async () => {
    stubGetSchema(STATISTICS_ROWS);
    const info = await makeDriver().getSchema('shop');

    expect(info.tables.find(t => t.name === 'orders')!.indexes).toEqual([
      { name: 'PRIMARY', unique: true, columns: ['id'], type: 'BTREE' },
      { name: 'idx_user_created', unique: false, columns: ['user_id', 'created_at'], type: 'BTREE' },
    ]);
    expect(info.tables.find(t => t.name === 'users')!.indexes).toEqual([
      { name: 'uq_email', unique: true, columns: ['email'], type: 'BTREE' },
    ]);
  });

  it('preserves SEQ_IN_INDEX order — it decides whether a query can use the index', async () => {
    stubGetSchema(STATISTICS_ROWS);
    const info = await makeDriver().getSchema('shop');
    const composite = info.tables.find(t => t.name === 'orders')!.indexes
      .find(i => i.name === 'idx_user_created')!;
    expect(composite.columns).toEqual(['user_id', 'created_at']);
  });

  it('asks the server for STATISTICS rows in index-position order', async () => {
    stubGetSchema([]);
    await makeDriver().getSchema('shop');
    const indexSql = mockConn.query.mock.calls[2][0] as string;
    expect(indexSql).toMatch(/information_schema\.STATISTICS/);
    expect(indexSql).toMatch(/ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX/);
  });

  it('leaves tables with no indexes as an empty list', async () => {
    stubGetSchema([]);
    const info = await makeDriver().getSchema('shop');
    expect(info.tables.map(t => t.indexes)).toEqual([[], []]);
  });

  it('renders MySQL 8 functional index parts (NULL COLUMN_NAME) as (expression)', async () => {
    stubGetSchema([
      { tbl: 'orders', idx: 'idx_upper_ref', col: null, non_unique: 1, idx_type: 'BTREE' },
    ]);
    const info = await makeDriver().getSchema('shop');
    expect(info.tables.find(t => t.name === 'orders')!.indexes[0].columns).toEqual(['(expression)']);
  });

  it('reports the access method for non-btree indexes', async () => {
    stubGetSchema([
      { tbl: 'orders', idx: 'ft_notes', col: 'notes', non_unique: 1, idx_type: 'FULLTEXT' },
    ]);
    const info = await makeDriver().getSchema('shop');
    expect(info.tables.find(t => t.name === 'orders')!.indexes[0].type).toBe('FULLTEXT');
  });

  it('getTable returns the indexes of that table only', async () => {
    mockConn.query
      .mockResolvedValueOnce([[{ name: 'orders', row_count: 3, comment: '' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([STATISTICS_ROWS])
      .mockResolvedValueOnce([[]]);
    const table = await makeDriver().getTable('shop', 'orders');
    expect(table!.indexes.map(i => i.name)).toEqual(['PRIMARY', 'idx_user_created']);
  });
});

describe('MysqlDriver – foreign key metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.getConnection.mockResolvedValue(mockConn);
  });

  // KEY_COLUMN_USAGE rows, one per (constraint, column) pair, in ORDINAL_POSITION order.
  const FK_ROWS = [
    { tbl: 'orders', name: 'fk_orders_user', col: 'user_id',
      ref_schema: 'shop', ref_tbl: 'users', ref_col: 'id' },
    { tbl: 'order_items', name: 'fk_items_order', col: 'order_tenant',
      ref_schema: 'shop', ref_tbl: 'orders', ref_col: 'tenant' },
    { tbl: 'order_items', name: 'fk_items_order', col: 'order_id',
      ref_schema: 'shop', ref_tbl: 'orders', ref_col: 'id' },
  ];

  function stubGetSchema(fkRows: Record<string, unknown>[]) {
    mockConn.query
      .mockResolvedValueOnce([[
        { name: 'orders', row_count: 3, comment: '' },
        { name: 'order_items', row_count: 9, comment: '' },
      ]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([fkRows])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);
  }

  it('folds KEY_COLUMN_USAGE rows into one entry per constraint, keyed by table', async () => {
    stubGetSchema(FK_ROWS);
    const info = await makeDriver().getSchema('shop');

    expect(info.tables.find(t => t.name === 'orders')!.foreignKeys).toEqual([
      {
        name: 'fk_orders_user',
        columns: ['user_id'],
        referencedSchema: 'shop',
        referencedTable: 'users',
        referencedColumns: ['id'],
      },
    ]);
  });

  it('keeps composite key columns aligned with the columns they reference', async () => {
    stubGetSchema(FK_ROWS);
    const info = await makeDriver().getSchema('shop');
    const fk = info.tables.find(t => t.name === 'order_items')!.foreignKeys[0];
    expect(fk.columns).toEqual(['order_tenant', 'order_id']);
    expect(fk.referencedColumns).toEqual(['tenant', 'id']);
  });

  it('asks only for rows that actually reference something, in constraint order', async () => {
    stubGetSchema([]);
    await makeDriver().getSchema('shop');
    const fkSql = mockConn.query.mock.calls[3][0] as string;
    expect(fkSql).toMatch(/information_schema\.KEY_COLUMN_USAGE/);
    expect(fkSql).toMatch(/REFERENCED_TABLE_NAME IS NOT NULL/);
    expect(fkSql).toMatch(/ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION/);
  });

  it('leaves tables with no foreign keys as an empty list', async () => {
    stubGetSchema([]);
    const info = await makeDriver().getSchema('shop');
    expect(info.tables.map(t => t.foreignKeys)).toEqual([[], []]);
  });

  it('preserves the referenced schema for a cross-schema reference', async () => {
    stubGetSchema([
      { tbl: 'orders', name: 'fk_orders_tenant', col: 'tenant_id',
        ref_schema: 'directory', ref_tbl: 'tenants', ref_col: 'id' },
    ]);
    const info = await makeDriver().getSchema('shop');
    expect(info.tables.find(t => t.name === 'orders')!.foreignKeys[0].referencedSchema).toBe('directory');
  });

  it('getTable returns the foreign keys of that table only', async () => {
    mockConn.query
      .mockResolvedValueOnce([[{ name: 'orders', row_count: 3, comment: '' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([FK_ROWS.filter(r => r.tbl === 'orders')]);
    const table = await makeDriver().getTable('shop', 'orders');
    expect(table!.foreignKeys.map(f => f.name)).toEqual(['fk_orders_user']);
  });
});

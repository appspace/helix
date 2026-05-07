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

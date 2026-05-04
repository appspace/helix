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
  });

  it('replaces the pool and ends the old one', async () => {
    const mysqlMod = (await import('mysql2/promise')).default as unknown as { createPool: ReturnType<typeof vi.fn> };
    const driver = makeDriver();
    expect(mysqlMod.createPool).toHaveBeenCalledTimes(1);

    mockPool.end.mockResolvedValueOnce(undefined);
    await driver.recyclePool();
    // One createPool call for the constructor, one for the recycle.
    expect(mysqlMod.createPool).toHaveBeenCalledTimes(2);
    expect(mockPool.end).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from the old pool — its sockets may already be dead', async () => {
    const driver = makeDriver();
    mockPool.end.mockRejectedValueOnce(new Error('socket closed'));
    await expect(driver.recyclePool()).resolves.toBeUndefined();
  });

  it('configures TCP keepalive on the pool so post-resume sockets are detected', async () => {
    const mysqlMod = (await import('mysql2/promise')).default as unknown as { createPool: ReturnType<typeof vi.fn> };
    mysqlMod.createPool.mockClear();
    makeDriver();
    expect(mysqlMod.createPool).toHaveBeenCalledTimes(1);
    const opts = mysqlMod.createPool.mock.calls[0][0];
    expect(opts.enableKeepAlive).toBe(true);
    expect(opts.keepAliveInitialDelay).toBe(10_000);
  });
});

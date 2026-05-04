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

vi.mock('pg', () => ({
  default: { Pool: vi.fn(() => mockPoolInstance) },
}));

import { PostgresDriver } from './postgres.js';

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
    Pool.mockImplementationOnce(() => oldPool).mockImplementationOnce(() => newPool);

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
    Pool.mockImplementationOnce(() => mockPoolInstance).mockImplementationOnce(() => newPool);

    const driver = makeDriver();
    await driver.recyclePool();

    expect(newPool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('coalesces concurrent recycle calls so a duplicate event does not orphan a pool', async () => {
    const Pool = await getPoolCtor();
    Pool.mockImplementation(() => mockPoolInstance);
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

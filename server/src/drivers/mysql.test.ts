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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db.js', () => ({ getPool: vi.fn() }));

import { getPool } from '../db.js';
import { postQuery } from './query.js';

// Minimal FieldPacket shape that postQuery reads from
function makeField(name: string, flags = 0, columnType = 253) {
  return { name, orgName: name, table: 't', orgTable: 't', flags, columnType, type: columnType };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/query', postQuery);
  return app;
}

describe('postQuery – connection pinning', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues USE and SELECT on the same connection when schema is provided', async () => {
    const mockConn = {
      query: vi.fn()
        .mockResolvedValueOnce([[], []])                          // USE `mydb`
        .mockResolvedValueOnce([                                  // SELECT * FROM users
          [{ id: 1, name: 'Alice' }],
          [makeField('id', /* PRI_KEY */ 2), makeField('name')],
        ]),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(mockConn) } as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: 'SELECT * FROM users', schema: 'mydb' });

    expect(res.status).toBe(200);

    // Both calls landed on the same mock connection object — not on pool directly
    expect(mockConn.query).toHaveBeenCalledTimes(2);
    expect(mockConn.query).toHaveBeenNthCalledWith(1, 'USE `mydb`');
    expect(mockConn.query).toHaveBeenNthCalledWith(2, 'SELECT * FROM users');

    // Connection is always returned to the pool
    expect(mockConn.release).toHaveBeenCalledTimes(1);

    // Spot-check response shape
    expect(res.body.columns).toEqual(['id', 'name']);
    expect(res.body.rows).toEqual([{ id: 1, name: 'Alice' }]);
    expect(res.body.columnMeta[0]).toMatchObject({ name: 'id', pk: true });
  });

  it('skips USE and runs the query directly when no schema is provided', async () => {
    const mockConn = {
      query: vi.fn().mockResolvedValueOnce([
        [{ one: 1 }],
        [makeField('one')],
      ]),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(mockConn) } as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: 'SELECT 1 AS one' });

    expect(res.status).toBe(200);
    expect(mockConn.query).toHaveBeenCalledTimes(1);
    expect(mockConn.query).toHaveBeenCalledWith('SELECT 1 AS one');
    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });

  it('releases the connection even when the query throws', async () => {
    const mockConn = {
      query: vi.fn()
        .mockResolvedValueOnce([[], []])  // USE succeeds
        .mockRejectedValueOnce(new Error("Table 'mydb.ghost' doesn't exist")),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(mockConn) } as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: 'SELECT * FROM ghost', schema: 'mydb' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ghost');
    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });

  it('releases the connection even when USE throws', async () => {
    const mockConn = {
      query: vi.fn().mockRejectedValueOnce(new Error("Unknown database 'noexist'")),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(mockConn) } as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: 'SELECT 1', schema: 'noexist' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('noexist');
    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });
});

describe('postQuery – input validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when sql is missing', async () => {
    const res = await request(makeApp()).post('/api/query').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sql is required/i);
  });

  it('returns 400 when sql is blank whitespace', async () => {
    const res = await request(makeApp()).post('/api/query').send({ sql: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sql is required/i);
  });
});

describe('postQuery – response serialization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serializes Buffer columns as hex strings', async () => {
    const mockConn = {
      query: vi.fn().mockResolvedValueOnce([
        [{ hash: Buffer.from('deadbeef', 'hex') }],
        [makeField('hash')],
      ]),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(mockConn) } as any);

    const res = await request(makeApp()).post('/api/query').send({ sql: 'SELECT hash FROM t' });

    expect(res.status).toBe(200);
    expect(res.body.rows[0].hash).toBe('deadbeef');
  });

  it('serializes Date columns as ISO-style strings without milliseconds', async () => {
    const mockConn = {
      query: vi.fn().mockResolvedValueOnce([
        [{ created_at: new Date('2024-06-15T12:34:56.000Z') }],
        [makeField('created_at')],
      ]),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(mockConn) } as any);

    const res = await request(makeApp()).post('/api/query').send({ sql: 'SELECT created_at FROM t' });

    expect(res.status).toBe(200);
    expect(res.body.rows[0].created_at).toBe('2024-06-15 12:34:56');
  });

  it('serializes BigInt columns as strings', async () => {
    const mockConn = {
      query: vi.fn().mockResolvedValueOnce([
        [{ big: BigInt('9007199254740993') }],
        [makeField('big')],
      ]),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(mockConn) } as any);

    const res = await request(makeApp()).post('/api/query').send({ sql: 'SELECT big FROM t' });

    expect(res.status).toBe(200);
    expect(res.body.rows[0].big).toBe('9007199254740993');
  });

  it('serializes NULL values as null', async () => {
    const mockConn = {
      query: vi.fn().mockResolvedValueOnce([
        [{ val: null }],
        [makeField('val')],
      ]),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(mockConn) } as any);

    const res = await request(makeApp()).post('/api/query').send({ sql: 'SELECT NULL AS val' });

    expect(res.status).toBe(200);
    expect(res.body.rows[0].val).toBeNull();
  });

  it('returns affectedRows and insertId for non-SELECT statements', async () => {
    const mockConn = {
      // mysql2 returns a ResultSetHeader (plain object, not array) for DML
      query: vi.fn().mockResolvedValueOnce([{ affectedRows: 3, insertId: 0 }]),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(mockConn) } as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: "UPDATE users SET active = 0 WHERE role = 'guest'" });

    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual([]);
    expect(res.body.rows).toEqual([]);
    expect(res.body.affectedRows).toBe(3);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db.js', () => ({
  getDriver: vi.fn(),
}));

import { getDriver } from '../db.js';
import { postQuery } from './query.js';

function makeMeta(name: string, { pk = false, unique = false, notNull = false } = {}) {
  return { name, orgName: name, table: 't', orgTable: 't', pk, unique, notNull, mysqlType: 253 };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/query', postQuery);
  return app;
}

describe('postQuery – driver delegation (sql mode)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes schema to driver.query() and returns rows + columnMeta', async () => {
    const mockDriver = {
      queryMode: 'sql' as const,
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1, name: 'Alice' }],
        columnMeta: [makeMeta('id', { pk: true }), makeMeta('name')],
      }),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: 'SELECT * FROM users', schema: 'mydb' });

    expect(res.status).toBe(200);
    expect(mockDriver.query).toHaveBeenCalledWith('SELECT * FROM users', [], 'mydb');
    expect(res.body.columns).toEqual(['id', 'name']);
    expect(res.body.rows).toEqual([{ id: 1, name: 'Alice' }]);
    expect(res.body.columnMeta[0]).toMatchObject({ name: 'id', pk: true });
    expect(res.body).toHaveProperty('executionTime');
  });

  it('passes undefined schema when no schema is provided', async () => {
    const mockDriver = {
      queryMode: 'sql' as const,
      query: vi.fn().mockResolvedValue({
        rows: [{ one: 1 }],
        columnMeta: [makeMeta('one')],
      }),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: 'SELECT 1 AS one' });

    expect(res.status).toBe(200);
    expect(mockDriver.query).toHaveBeenCalledWith('SELECT 1 AS one', [], undefined);
  });

  it('returns affectedRows and insertId for DML (empty columnMeta)', async () => {
    const mockDriver = {
      queryMode: 'sql' as const,
      query: vi.fn().mockResolvedValue({
        rows: [],
        columnMeta: [],
        affectedRows: 3,
        insertId: 0,
      }),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: "UPDATE users SET active = 0 WHERE role = 'guest'" });

    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual([]);
    expect(res.body.rows).toEqual([]);
    expect(res.body.affectedRows).toBe(3);
  });

  it('returns 400 when driver.query() throws', async () => {
    const mockDriver = {
      queryMode: 'sql' as const,
      query: vi.fn().mockRejectedValue(new Error("Table 'mydb.ghost' doesn't exist")),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: 'SELECT * FROM ghost', schema: 'mydb' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ghost');
  });
});

describe('postQuery – input validation (sql mode)', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockSqlDriver() {
    vi.mocked(getDriver).mockReturnValue({
      queryMode: 'sql' as const,
      query: vi.fn(),
    } as any);
  }

  it('returns 400 when sql is missing', async () => {
    mockSqlDriver();
    const res = await request(makeApp()).post('/api/query').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sql is required/i);
  });

  it('returns 400 when sql is blank whitespace', async () => {
    mockSqlDriver();
    const res = await request(makeApp()).post('/api/query').send({ sql: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sql is required/i);
  });
});

describe('postQuery – row serialization passthrough', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes driver-serialized rows straight through to the response', async () => {
    const mockDriver = {
      queryMode: 'sql' as const,
      query: vi.fn().mockResolvedValue({
        rows: [{ hash: 'deadbeef', created_at: '2024-06-15 12:34:56', big: '9007199254740993', val: null }],
        columnMeta: [makeMeta('hash'), makeMeta('created_at'), makeMeta('big'), makeMeta('val')],
      }),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: 'SELECT hash, created_at, big, val FROM t' });

    expect(res.status).toBe(200);
    expect(res.body.rows[0].hash).toBe('deadbeef');
    expect(res.body.rows[0].created_at).toBe('2024-06-15 12:34:56');
    expect(res.body.rows[0].big).toBe('9007199254740993');
    expect(res.body.rows[0].val).toBeNull();
  });
});

describe('postQuery – mql mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards an MQL request body to the driver as JSON', async () => {
    const mockDriver = {
      queryMode: 'mql' as const,
      query: vi.fn().mockResolvedValue({
        rows: [{ _id: 'abc', name: 'Alice' }],
        columnMeta: [makeMeta('_id', { pk: true }), makeMeta('name')],
      }),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const mql = { collection: 'users', operation: 'find', filter: { active: true }, limit: 10 };

    const res = await request(makeApp())
      .post('/api/query')
      .send({ mql, schema: 'mydb' });

    expect(res.status).toBe(200);
    expect(mockDriver.query).toHaveBeenCalledTimes(1);
    const [queryArg, paramsArg, schemaArg] = mockDriver.query.mock.calls[0];
    expect(typeof queryArg).toBe('string');
    expect(JSON.parse(queryArg as string)).toEqual(mql);
    expect(paramsArg).toEqual([]);
    expect(schemaArg).toBe('mydb');
    expect(res.body.rows).toEqual([{ _id: 'abc', name: 'Alice' }]);
    expect(res.body.columns).toEqual(['_id', 'name']);
  });

  it('returns affectedRows for write operations (empty columnMeta)', async () => {
    const mockDriver = {
      queryMode: 'mql' as const,
      query: vi.fn().mockResolvedValue({
        rows: [],
        columnMeta: [],
        affectedRows: 1,
        insertId: null,
      }),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ mql: { collection: 'users', operation: 'insertOne', document: { name: 'Bob' } } });

    expect(res.status).toBe(200);
    expect(res.body.affectedRows).toBe(1);
    expect(res.body.rows).toEqual([]);
  });

  it('returns 400 when mql is missing in mql mode', async () => {
    vi.mocked(getDriver).mockReturnValue({ queryMode: 'mql' as const, query: vi.fn() } as any);
    const res = await request(makeApp()).post('/api/query').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mql/i);
  });

  it('returns 400 when driver.query() throws in mql mode', async () => {
    const mockDriver = {
      queryMode: 'mql' as const,
      query: vi.fn().mockRejectedValue(new Error('Unsupported MQL operation: foo')),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ mql: { collection: 'users', operation: 'foo' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unsupported MQL operation');
  });
});

describe('postQuery – mode mismatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when a SQL string is sent to a mql-mode driver', async () => {
    const mockDriver = { queryMode: 'mql' as const, query: vi.fn() };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ sql: 'SELECT 1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/MQL mode/i);
    expect(res.body.error).toMatch(/SQL string/i);
    expect(mockDriver.query).not.toHaveBeenCalled();
  });

  it('returns 400 when an MQL object is sent to a sql-mode driver', async () => {
    const mockDriver = { queryMode: 'sql' as const, query: vi.fn() };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp())
      .post('/api/query')
      .send({ mql: { collection: 'users', operation: 'find' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SQL mode/i);
    expect(res.body.error).toMatch(/MQL request/i);
    expect(mockDriver.query).not.toHaveBeenCalled();
  });
});

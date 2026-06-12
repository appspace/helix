import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db.js', () => ({
  getDriver: vi.fn(),
  getActiveConfig: vi.fn(),
}));

import { getDriver, getActiveConfig } from '../db.js';
import { postExplain } from './explain.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/explain', postExplain);
  return app;
}

function mockMysql(driver: Record<string, unknown>) {
  vi.mocked(getDriver).mockReturnValue({ queryMode: 'sql', ...driver } as any);
  vi.mocked(getActiveConfig).mockReturnValue({ type: 'mysql' } as any);
}

describe('postExplain – MySQL', () => {
  beforeEach(() => vi.clearAllMocks());

  it('wraps the query in EXPLAIN FORMAT=JSON and returns the parsed plan', async () => {
    const planJson = JSON.stringify({
      query_block: {
        select_id: 1,
        table: { table_name: 'users', access_type: 'ALL' },
      },
    });
    const query = vi.fn().mockResolvedValue({
      rows: [{ EXPLAIN: planJson }],
      columnMeta: [],
    });
    mockMysql({ query });

    const res = await request(makeApp())
      .post('/api/explain')
      .send({ sql: 'SELECT * FROM users', schema: 'mydb' });

    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith('EXPLAIN FORMAT=JSON SELECT * FROM users', [], 'mydb');
    expect(res.body.plan).toEqual({
      query_block: {
        select_id: 1,
        table: { table_name: 'users', access_type: 'ALL' },
      },
    });
    expect(res.body).toHaveProperty('executionTime');
    expect(res.body.explainSql).toBe('EXPLAIN FORMAT=JSON SELECT * FROM users');
  });

  it('strips a trailing semicolon so EXPLAIN does not see a multi-statement payload', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ EXPLAIN: '{"query_block":{}}' }],
      columnMeta: [],
    });
    mockMysql({ query });

    await request(makeApp())
      .post('/api/explain')
      .send({ sql: 'SELECT 1;  ' });

    expect(query).toHaveBeenCalledWith('EXPLAIN FORMAT=JSON SELECT 1', [], undefined);
  });

  it('returns the value unparsed if the driver hands back something that is not valid JSON', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ EXPLAIN: 'not-json' }],
      columnMeta: [],
    });
    mockMysql({ query });

    const res = await request(makeApp())
      .post('/api/explain')
      .send({ sql: 'SELECT 1' });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('not-json');
  });

  it('returns 400 when sql is missing', async () => {
    mockMysql({ query: vi.fn() });
    const res = await request(makeApp()).post('/api/explain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sql is required/i);
  });

  it('returns 400 when sql is blank whitespace', async () => {
    mockMysql({ query: vi.fn() });
    const res = await request(makeApp()).post('/api/explain').send({ sql: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sql is required/i);
  });

  it('returns 400 when the driver throws (e.g. invalid SQL)', async () => {
    const query = vi.fn().mockRejectedValue(new Error("Table 'mydb.ghost' doesn't exist"));
    mockMysql({ query });

    const res = await request(makeApp())
      .post('/api/explain')
      .send({ sql: 'SELECT * FROM ghost' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ghost');
  });
});

describe('postExplain – mode / dialect gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when the connection is in MQL mode', async () => {
    vi.mocked(getDriver).mockReturnValue({ queryMode: 'mql', query: vi.fn() } as any);
    vi.mocked(getActiveConfig).mockReturnValue({ type: 'mongodb' } as any);

    const res = await request(makeApp())
      .post('/api/explain')
      .send({ sql: 'SELECT 1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SQL connections/i);
  });

  it('returns 400 for non-MySQL SQL drivers (until Postgres support lands)', async () => {
    const query = vi.fn();
    vi.mocked(getDriver).mockReturnValue({ queryMode: 'sql', query } as any);
    vi.mocked(getActiveConfig).mockReturnValue({ type: 'postgres' } as any);

    const res = await request(makeApp())
      .post('/api/explain')
      .send({ sql: 'SELECT 1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/MySQL/i);
    expect(query).not.toHaveBeenCalled();
  });
});

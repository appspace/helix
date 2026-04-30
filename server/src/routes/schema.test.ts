import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db.js', () => ({
  getDriver: vi.fn(),
}));

import { getDriver } from '../db.js';
import { getSchemas, getSchema } from './schema.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/schemas', getSchemas);
  app.get('/api/schema', getSchema);
  return app;
}

function sqlColumn(name: string, opts: Partial<{ pk: boolean; nullable: boolean; type: string }> = {}) {
  return {
    name,
    type: opts.type ?? 'varchar(255)',
    dataType: opts.type ?? 'varchar',
    pk: opts.pk ?? false,
    nullable: opts.nullable ?? true,
    default: null,
    autoIncrement: false,
    comment: '',
  };
}

function mqlColumn(name: string, dataType: string, opts: Partial<{ pk: boolean; nullable: boolean }> = {}) {
  return {
    name,
    type: dataType,
    dataType,
    pk: opts.pk ?? false,
    nullable: opts.nullable ?? true,
    default: null,
    autoIncrement: false,
    comment: '',
    inferred: true,
  };
}

describe('getSchemas — driver delegation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the list of schemas from a sql-mode driver', async () => {
    const mockDriver = {
      queryMode: 'sql' as const,
      getSchemas: vi.fn().mockResolvedValue(['app', 'analytics']),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp()).get('/api/schemas');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ schemas: ['app', 'analytics'] });
    expect(mockDriver.getSchemas).toHaveBeenCalledTimes(1);
  });

  it('returns the list of databases from a mql-mode driver', async () => {
    const mockDriver = {
      queryMode: 'mql' as const,
      getSchemas: vi.fn().mockResolvedValue(['blog', 'shop']),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp()).get('/api/schemas');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ schemas: ['blog', 'shop'] });
    expect(mockDriver.getSchemas).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the driver throws', async () => {
    const mockDriver = {
      queryMode: 'sql' as const,
      getSchemas: vi.fn().mockRejectedValue(new Error('boom')),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp()).get('/api/schemas');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });
});

describe('getSchema — sql mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns tables/views/procedures/triggers without inferred flags', async () => {
    const mockDriver = {
      queryMode: 'sql' as const,
      getSchema: vi.fn().mockResolvedValue({
        tables: [
          {
            name: 'users',
            rows: 42,
            comment: '',
            columns: [sqlColumn('id', { pk: true, nullable: false, type: 'int' }), sqlColumn('email')],
          },
        ],
        views: ['active_users'],
        procedures: ['cleanup'],
        triggers: ['audit_users'],
      }),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp()).get('/api/schema').query({ schema: 'app' });

    expect(res.status).toBe(200);
    expect(mockDriver.getSchema).toHaveBeenCalledWith('app');
    expect(res.body.tables).toHaveLength(1);
    expect(res.body.tables[0].columns[0]).not.toHaveProperty('inferred');
    expect(res.body.views).toEqual(['active_users']);
    expect(res.body.procedures).toEqual(['cleanup']);
    expect(res.body.triggers).toEqual(['audit_users']);
  });
});

describe('getSchema — mql mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns collections as tables with inferred:true on every column', async () => {
    const mockDriver = {
      queryMode: 'mql' as const,
      getSchema: vi.fn().mockResolvedValue({
        tables: [
          {
            name: 'users',
            rows: 100,
            comment: '',
            columns: [
              mqlColumn('_id', 'objectId', { pk: true, nullable: false }),
              mqlColumn('name', 'string'),
              mqlColumn('age', 'int'),
            ],
          },
          {
            name: 'orders',
            rows: 5,
            comment: '',
            columns: [
              mqlColumn('_id', 'objectId', { pk: true, nullable: false }),
              mqlColumn('total', 'double'),
            ],
          },
        ],
        views: [],
        procedures: [],
        triggers: [],
      }),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp()).get('/api/schema').query({ schema: 'blog' });

    expect(res.status).toBe(200);
    expect(mockDriver.getSchema).toHaveBeenCalledWith('blog');
    expect(res.body.tables).toHaveLength(2);
    expect(res.body.tables[0].name).toBe('users');
    for (const t of res.body.tables) {
      for (const c of t.columns) {
        expect(c.inferred).toBe(true);
      }
    }
    expect(res.body.procedures).toEqual([]);
    expect(res.body.triggers).toEqual([]);
  });

  it('handles heterogeneous collections where sampled docs have different fields', async () => {
    // Best-effort inference: each collection reflects whatever fields the
    // single sampled document had, so neighbours can disagree on the column set.
    const mockDriver = {
      queryMode: 'mql' as const,
      getSchema: vi.fn().mockResolvedValue({
        tables: [
          {
            name: 'events',
            rows: 3,
            comment: '',
            columns: [
              mqlColumn('_id', 'objectId', { pk: true, nullable: false }),
              mqlColumn('type', 'string'),
              mqlColumn('payload', 'object'),
            ],
          },
          {
            name: 'sparse',
            rows: 1,
            comment: '',
            columns: [mqlColumn('_id', 'objectId', { pk: true, nullable: false })],
          },
        ],
        views: [],
        procedures: [],
        triggers: [],
      }),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp()).get('/api/schema').query({ schema: 'mixed' });

    expect(res.status).toBe(200);
    const cols = (name: string) =>
      res.body.tables.find((t: { name: string }) => t.name === name).columns.map((c: { name: string }) => c.name);
    expect(cols('events')).toEqual(['_id', 'type', 'payload']);
    expect(cols('sparse')).toEqual(['_id']);
  });

  it('does not crash when a collection has no sample and only the _id placeholder column is returned', async () => {
    const mockDriver = {
      queryMode: 'mql' as const,
      getSchema: vi.fn().mockResolvedValue({
        tables: [
          {
            name: 'empty',
            rows: 0,
            comment: '',
            columns: [mqlColumn('_id', 'objectId', { pk: true, nullable: false })],
          },
        ],
        views: [],
        procedures: [],
        triggers: [],
      }),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp()).get('/api/schema').query({ schema: 'edge' });

    expect(res.status).toBe(200);
    expect(res.body.tables[0].columns).toEqual([
      expect.objectContaining({ name: '_id', inferred: true, pk: true }),
    ]);
  });

  it('returns 500 when the mql-mode driver throws', async () => {
    const mockDriver = {
      queryMode: 'mql' as const,
      getSchema: vi.fn().mockRejectedValue(new Error('listCollections failed')),
    };
    vi.mocked(getDriver).mockReturnValue(mockDriver as any);

    const res = await request(makeApp()).get('/api/schema').query({ schema: 'broken' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('listCollections failed');
  });
});

describe('getSchema — input validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when schema query param is missing', async () => {
    const res = await request(makeApp()).get('/api/schema');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/schema/i);
  });

  it('returns 400 when schema is blank whitespace', async () => {
    const res = await request(makeApp()).get('/api/schema').query({ schema: '   ' });
    expect(res.status).toBe(400);
  });
});

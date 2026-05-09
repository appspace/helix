import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db.js', () => ({
  getDriver: vi.fn(),
}));

import { getDriver } from '../db.js';
import { postCreateTable } from './createTable.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/create-table', postCreateTable);
  return app;
}

const SQL = 'CREATE TABLE `users` (\n  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY\n);';

describe('postCreateTable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the SQL to the driver and echoes it back on success', async () => {
    const driver = { query: vi.fn().mockResolvedValue({ rows: [], columnMeta: [] }) };
    vi.mocked(getDriver).mockReturnValue(driver as never);

    const res = await request(makeApp()).post('/api/create-table').send({ sql: SQL });

    expect(res.status).toBe(200);
    expect(driver.query).toHaveBeenCalledWith(SQL);
    expect(res.body).toEqual({ ok: true, sql: SQL });
  });

  it('rejects an empty body with 400', async () => {
    const driver = { query: vi.fn() };
    vi.mocked(getDriver).mockReturnValue(driver as never);

    const res = await request(makeApp()).post('/api/create-table').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sql is required/);
    expect(driver.query).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only sql with 400', async () => {
    const driver = { query: vi.fn() };
    vi.mocked(getDriver).mockReturnValue(driver as never);

    const res = await request(makeApp()).post('/api/create-table').send({ sql: '   \n  ' });

    expect(res.status).toBe(400);
    expect(driver.query).not.toHaveBeenCalled();
  });

  it('surfaces driver errors as 400 with the message', async () => {
    const driver = { query: vi.fn().mockRejectedValue(new Error('table already exists')) };
    vi.mocked(getDriver).mockReturnValue(driver as never);

    const res = await request(makeApp()).post('/api/create-table').send({ sql: SQL });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('table already exists');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db.js', () => ({
  getDriver: vi.fn(),
}));

import { getDriver } from '../db.js';
import { postAlterTable } from './alterTable.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/alter-table', postAlterTable);
  return app;
}

const SQL = 'ALTER TABLE `users`\n  CHANGE COLUMN `email` `mail` VARCHAR(255) NOT NULL;';

describe('postAlterTable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the SQL to the driver and echoes it back on success', async () => {
    const driver = { query: vi.fn().mockResolvedValue({ rows: [], columnMeta: [] }) };
    vi.mocked(getDriver).mockReturnValue(driver as never);

    const res = await request(makeApp()).post('/api/alter-table').send({ sql: SQL });

    expect(res.status).toBe(200);
    expect(driver.query).toHaveBeenCalledWith(SQL);
    expect(res.body).toEqual({ ok: true, sql: SQL });
  });

  it('rejects an empty body with 400', async () => {
    const driver = { query: vi.fn() };
    vi.mocked(getDriver).mockReturnValue(driver as never);

    const res = await request(makeApp()).post('/api/alter-table').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sql is required/);
    expect(driver.query).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only sql with 400', async () => {
    const driver = { query: vi.fn() };
    vi.mocked(getDriver).mockReturnValue(driver as never);

    const res = await request(makeApp()).post('/api/alter-table').send({ sql: '   \n  ' });

    expect(res.status).toBe(400);
    expect(driver.query).not.toHaveBeenCalled();
  });

  it('surfaces driver errors as 400 with the message', async () => {
    const driver = { query: vi.fn().mockRejectedValue(new Error('column does not exist')) };
    vi.mocked(getDriver).mockReturnValue(driver as never);

    const res = await request(makeApp()).post('/api/alter-table').send({ sql: SQL });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('column does not exist');
  });
});

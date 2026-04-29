import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db.js', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  testConnection: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),
  getActiveConfig: vi.fn().mockReturnValue(null),
}));

import { connect, testConnection } from '../db.js';
import { postConnect, postTestConnect } from './connect.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/connect', postConnect);
  app.post('/api/connect/test', postTestConnect);
  return app;
}

describe('postConnect — db type plumbing', () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to type 'mysql' and port 3306 when type is omitted", async () => {
    const res = await request(makeApp())
      .post('/api/connect')
      .send({ host: 'h', user: 'u', password: 'p' });
    expect(res.status).toBe(200);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ type: 'mysql', port: 3306 }));
  });

  it("forwards type 'postgres' and uses port 5432 by default", async () => {
    const res = await request(makeApp())
      .post('/api/connect')
      .send({ host: 'h', user: 'u', password: 'p', type: 'postgres' });
    expect(res.status).toBe(200);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ type: 'postgres', port: 5432 }));
  });

  it('honors an explicit port over the type-default', async () => {
    await request(makeApp())
      .post('/api/connect')
      .send({ host: 'h', user: 'u', password: 'p', type: 'postgres', port: 9999 });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ type: 'postgres', port: 9999 }));
  });

  it('returns 400 for unknown type', async () => {
    const res = await request(makeApp())
      .post('/api/connect')
      .send({ host: 'h', user: 'u', password: 'p', type: 'mariadb' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported db type/i);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('postTestConnect — db type plumbing', () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards type 'postgres' through to testConnection()", async () => {
    const res = await request(makeApp())
      .post('/api/connect/test')
      .send({ host: 'h', user: 'u', password: 'p', type: 'postgres' });
    expect(res.status).toBe(200);
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({ type: 'postgres', port: 5432 }));
  });

  it("defaults to type 'mysql' when type is omitted", async () => {
    await request(makeApp())
      .post('/api/connect/test')
      .send({ host: 'h', user: 'u', password: 'p' });
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({ type: 'mysql', port: 3306 }));
  });

  it('returns 400 for unknown type', async () => {
    const res = await request(makeApp())
      .post('/api/connect/test')
      .send({ host: 'h', user: 'u', password: 'p', type: 42 });
    expect(res.status).toBe(400);
    expect(testConnection).not.toHaveBeenCalled();
  });
});

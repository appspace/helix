import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db.js', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  testConnection: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),
  getActiveConfig: vi.fn().mockReturnValue(null),
  getDriver: vi.fn().mockReturnValue({ queryMode: 'sql' }),
}));

import { connect, testConnection } from '../db.js';
import { postConnect, postTestConnect, friendlyConnectError } from './connect.js';

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

  it("forwards type 'mongodb' and uses port 27017 by default", async () => {
    const res = await request(makeApp())
      .post('/api/connect')
      .send({ host: 'h', user: 'u', password: 'p', type: 'mongodb' });
    expect(res.status).toBe(200);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ type: 'mongodb', port: 27017 }));
  });

  it("forwards an optional connectionString through to connect()", async () => {
    const uri = 'mongodb+srv://u:p@cluster0.example.net/db';
    const res = await request(makeApp())
      .post('/api/connect')
      .send({ type: 'mongodb', connectionString: uri });
    expect(res.status).toBe(200);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ type: 'mongodb', connectionString: uri }));
  });

  it("does not include connectionString when omitted", async () => {
    await request(makeApp())
      .post('/api/connect')
      .send({ host: 'h', user: 'u', password: 'p', type: 'mongodb' });
    const cfg = (connect as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cfg).not.toHaveProperty('connectionString');
  });

  it('rejects with 400 when connectionString and user are both provided', async () => {
    const res = await request(makeApp())
      .post('/api/connect')
      .send({ user: 'u', type: 'mongodb', connectionString: 'mongodb://x/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/either connectionString or user\/password/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects with 400 when connectionString and password are both provided', async () => {
    const res = await request(makeApp())
      .post('/api/connect')
      .send({ password: 'p', type: 'mongodb', connectionString: 'mongodb://x/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/either connectionString or user\/password/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns a connectionName parsed from the URI when connectionString is used', async () => {
    const res = await request(makeApp())
      .post('/api/connect')
      .send({
        type: 'mongodb',
        connectionString: 'mongodb+srv://alice:secret@cluster0.example.net/db',
      });
    expect(res.status).toBe(200);
    // Password must not appear; host should come from the URI, not form fields.
    expect(res.body.connectionName).toBe('alice@cluster0.example.net');
    expect(res.body.connectionName).not.toMatch(/secret/);
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

  it("forwards type 'mongodb' through to testConnection() with port 27017", async () => {
    const res = await request(makeApp())
      .post('/api/connect/test')
      .send({ host: 'h', user: 'u', password: 'p', type: 'mongodb' });
    expect(res.status).toBe(200);
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({ type: 'mongodb', port: 27017 }));
  });
});

describe('friendlyConnectError — MongoDB error mapping', () => {
  it('maps AuthenticationFailed (codeName) to a friendly access-denied message', () => {
    const msg = friendlyConnectError(
      { codeName: 'AuthenticationFailed', message: 'auth failed' },
      'h', 27017, 'mongodb',
    );
    expect(msg).toMatch(/access denied/i);
    expect(msg).toMatch(/AuthenticationFailed/);
  });

  it('prefers codeName over numeric code so the byCode lookup hits', () => {
    // Mongo errors carry both fields. With code precedence, the lookup would
    // miss (18 isn't keyed) and the raw message would surface — so the test
    // would not match /access denied/.
    const msg = friendlyConnectError(
      { code: '18', codeName: 'AuthenticationFailed', message: 'auth failed' },
      'h', 27017, 'mongodb',
    );
    expect(msg).toMatch(/access denied/i);
    expect(msg).toMatch(/AuthenticationFailed/);
  });

  it("uses 'MongoDB' in the unknown-error fallback when type is mongodb", () => {
    const msg = friendlyConnectError({}, 'h', 27017, 'mongodb');
    expect(msg).toMatch(/MongoDB/);
  });
});

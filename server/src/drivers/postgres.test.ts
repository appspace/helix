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

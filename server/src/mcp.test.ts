import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  getDriver: vi.fn(),
  getActiveConfig: vi.fn(),
  isConnected: vi.fn(),
}));
vi.mock('./mcp-state.js', () => ({
  isMcpWritesAllowed: vi.fn(),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDriver, getActiveConfig, isConnected } from './db.js';
import { isMcpWritesAllowed } from './mcp-state.js';
import { buildMcpServer } from './mcp.js';

async function connectClient() {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function mockMongoDriver(query = vi.fn()) {
  const driver = {
    queryMode: 'mql' as const,
    query,
    getSchemas: vi.fn().mockResolvedValue(['shop']),
    getSchema: vi.fn().mockResolvedValue({ tables: [{ name: 'users', rows: 3 }], views: [] }),
    getTable: vi.fn().mockResolvedValue({ name: 'users', rows: 3, columns: [] }),
    getCollectionInfo: vi.fn().mockResolvedValue({ validator: null, indexes: [] }),
  };
  vi.mocked(getDriver).mockReturnValue(driver as any);
  return driver;
}

describe('MCP server – driver-aware toolset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(getActiveConfig).mockReturnValue({ type: 'mongodb', database: 'shop' } as any);
    vi.mocked(isMcpWritesAllowed).mockReturnValue(false);
  });

  it('exposes MongoDB tools (not SQL tools) on a Mongo connection', async () => {
    mockMongoDriver();
    const { client } = await connectClient();
    const names = (await client.listTools()).tools.map(t => t.name).sort();

    expect(names).toContain('find_documents');
    expect(names).toContain('aggregate_documents');
    expect(names).toContain('count_documents');
    expect(names).toContain('list_collections');
    expect(names).not.toContain('execute_query');
    expect(names).not.toContain('execute_write');
  });

  it('exposes SQL tools on a SQL connection', async () => {
    vi.mocked(getActiveConfig).mockReturnValue({ type: 'postgres', database: 'shop' } as any);
    vi.mocked(getDriver).mockReturnValue({ queryMode: 'sql' } as any);
    const { client } = await connectClient();
    const names = (await client.listTools()).tools.map(t => t.name).sort();

    expect(names).toContain('execute_query');
    expect(names).toContain('execute_write');
    expect(names).not.toContain('find_documents');
  });

  it('server instructions tell the model it is MongoDB and not to write SQL', async () => {
    mockMongoDriver();
    const { client } = await connectClient();
    const instructions = client.getInstructions() ?? '';

    expect(instructions).toMatch(/mongodb/i);
    expect(instructions).toMatch(/do not write sql/i);
  });

  it('find_documents assembles a JSON-encoded MQL request for the driver', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ _id: 'a1', email: 'x@y.z' }],
      columnMeta: [{ name: '_id' }, { name: 'email' }],
    });
    mockMongoDriver(query);
    const { client } = await connectClient();

    const res: any = await client.callTool({
      name: 'find_documents',
      arguments: { collection: 'users', filter: { email: 'x@y.z' }, schema: 'shop' },
    });

    expect(res.isError).toBeFalsy();
    const [sql, params, schema] = query.mock.calls[0];
    expect(JSON.parse(sql)).toMatchObject({
      collection: 'users',
      operation: 'find',
      filter: { email: 'x@y.z' },
      limit: 100,
    });
    expect(params).toEqual([]);
    expect(schema).toBe('shop');
    expect(JSON.parse(res.content[0].text).documents).toEqual([{ _id: 'a1', email: 'x@y.z' }]);
  });

  it('blocks insert_document when writes are disabled', async () => {
    const query = vi.fn();
    mockMongoDriver(query);
    const { client } = await connectClient();

    const res: any = await client.callTool({
      name: 'insert_document',
      arguments: { collection: 'users', document: { email: 'x@y.z' } },
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Allow MCP to modify data/);
    expect(query).not.toHaveBeenCalled();
  });

  it('allows insert_document when writes are enabled', async () => {
    vi.mocked(isMcpWritesAllowed).mockReturnValue(true);
    const query = vi.fn().mockResolvedValue({ rows: [], columnMeta: [], affectedRows: 1 });
    mockMongoDriver(query);
    const { client } = await connectClient();

    const res: any = await client.callTool({
      name: 'insert_document',
      arguments: { collection: 'users', document: { email: 'x@y.z' } },
    });

    expect(res.isError).toBeFalsy();
    expect(JSON.parse(query.mock.calls[0][0])).toMatchObject({
      collection: 'users',
      operation: 'insertOne',
      document: { email: 'x@y.z' },
    });
    expect(JSON.parse(res.content[0].text).insertedCount).toBe(1);
  });

  it('update_document requires a filter or id', async () => {
    vi.mocked(isMcpWritesAllowed).mockReturnValue(true);
    const query = vi.fn();
    mockMongoDriver(query);
    const { client } = await connectClient();

    const res: any = await client.callTool({
      name: 'update_document',
      arguments: { collection: 'users', update: { $set: { active: true } } },
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/requires either "filter" or "id"/);
    expect(query).not.toHaveBeenCalled();
  });
});

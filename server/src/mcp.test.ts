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

function mockSqlDriver(query = vi.fn()) {
  const driver = { queryMode: 'sql' as const, query };
  vi.mocked(getDriver).mockReturnValue(driver as any);
  return driver;
}

describe('MCP server – invariant toolset with per-call mode guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(getActiveConfig).mockReturnValue({ type: 'mongodb', database: 'shop' } as any);
    vi.mocked(isMcpWritesAllowed).mockReturnValue(false);
  });

  it('advertises the same full toolset regardless of connected DB (no stale-cache problem)', async () => {
    // Mongo connection
    mockMongoDriver();
    const mongoNames = (await connectClient()).client.listTools().then(r => r.tools.map(t => t.name).sort());
    // SQL connection
    vi.mocked(getActiveConfig).mockReturnValue({ type: 'postgres', database: 'shop' } as any);
    mockSqlDriver();
    const sqlNames = (await connectClient()).client.listTools().then(r => r.tools.map(t => t.name).sort());

    const expected = [
      'aggregate_documents', 'connection_info', 'count_documents', 'delete_document',
      'describe_collection', 'describe_table', 'execute_query', 'execute_write',
      'find_documents', 'insert_document', 'list_collections', 'list_tables', 'update_document',
    ];
    expect(await mongoNames).toEqual(expected);
    expect(await sqlNames).toEqual(expected);
  });

  it('connection_info reports the connected database type and which tools to use', async () => {
    mockMongoDriver();
    const { client } = await connectClient();
    const res: any = await client.callTool({ name: 'connection_info', arguments: {} });
    const info = JSON.parse(res.content[0].text);

    expect(info).toMatchObject({
      connected: true,
      databaseType: 'mongodb',
      queryLanguage: 'MongoDB (MQL)',
    });
    expect(info.useTools.read).toContain('find_documents');
  });

  it('a SQL tool on a Mongo connection returns an actionable mismatch error, not "tool not found"', async () => {
    const query = vi.fn();
    mockMongoDriver(query);
    const { client } = await connectClient();

    const res: any = await client.callTool({
      name: 'execute_query',
      arguments: { sql: 'SELECT 1' },
    });

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toMatch(/MongoDB database/);
    expect(text).toMatch(/find_documents/);
    expect(text).toMatch(/connection_info/);
    expect(query).not.toHaveBeenCalled();
  });

  it('a MongoDB tool on a SQL connection returns an actionable mismatch error', async () => {
    vi.mocked(getActiveConfig).mockReturnValue({ type: 'postgres', database: 'shop' } as any);
    const query = vi.fn();
    mockSqlDriver(query);
    const { client } = await connectClient();

    const res: any = await client.callTool({
      name: 'find_documents',
      arguments: { collection: 'users' },
    });

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toMatch(/postgres \(SQL\) database/);
    expect(text).toMatch(/execute_query/);
    expect(query).not.toHaveBeenCalled();
  });

  it('server instructions name the connected DB and point at connection_info', async () => {
    mockMongoDriver();
    const { client } = await connectClient();
    const instructions = client.getInstructions() ?? '';

    expect(instructions).toMatch(/connection_info/);
    expect(instructions).toMatch(/mongodb database/i);
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

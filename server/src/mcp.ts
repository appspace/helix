import type { RequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getDriver, getActiveConfig, isConnected } from './db.js';
import { isMcpWritesAllowed } from './mcp-state.js';
import type { QueryResult } from './drivers/interface.js';

const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 10_000;

const READ_KEYWORDS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH']);
const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

// Tool names grouped by database family, reused in guard messages and connection_info.
const SQL_TOOLS = 'execute_query, execute_write, list_tables, describe_table';
const MONGO_READ_TOOLS = 'find_documents, aggregate_documents, count_documents, list_collections, describe_collection';
const MONGO_WRITE_TOOLS = 'insert_document, update_document, delete_document';

function firstKeyword(sql: string): string {
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '').trimStart();
  const match = stripped.match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : '';
}

function toolError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function toolJson(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function requireConnection(): string | null {
  if (!isConnected()) {
    return 'No active database connection. Connect to a database via the Helix UI first.';
  }
  return null;
}

/**
 * Guard a tool to the query language of the connected database.
 *
 * The tool list is intentionally invariant across connections — every tool is
 * always advertised — so a client that cached `tools/list` never ends up with a
 * stale set when the user connects or switches databases mid-session. Instead,
 * a tool from the wrong family returns this actionable message at call time,
 * naming the connected DB type and the tools that actually apply, so the agent
 * can self-correct (or ask the user to reconnect) instead of seeing a cryptic
 * "tool not found". Caller must have already passed requireConnection().
 */
function requireMode(expected: 'sql' | 'mql'): string | null {
  if (getDriver().queryMode === expected) return null;
  if (expected === 'sql') {
    // A SQL tool was invoked, but the live connection is MongoDB.
    return (
      'This MCP connection is a MongoDB database, so the SQL tools do not apply here. ' +
      `Use the MongoDB tools instead — reads: ${MONGO_READ_TOOLS}; writes: ${MONGO_WRITE_TOOLS}. ` +
      'Call connection_info to confirm the connected database; if your client cached an older ' +
      'tool list, re-list tools or reconnect the MCP server.'
    );
  }
  // A MongoDB tool was invoked, but the live connection is SQL.
  const dbType = getActiveConfig()?.type ?? 'SQL';
  return (
    `This MCP connection is a ${dbType} (SQL) database, so the MongoDB tools do not apply here. ` +
    `Use the SQL tools instead: ${SQL_TOOLS}. ` +
    'Call connection_info to confirm the connected database; if your client cached an older ' +
    'tool list, re-list tools or reconnect the MCP server.'
  );
}

// ---------------------------------------------------------------------------
// connection_info — always available, regardless of database family.
// ---------------------------------------------------------------------------

function registerConnectionInfo(server: McpServer): void {
  server.registerTool(
    'connection_info',
    {
      description:
        'Report the database the MCP server is currently connected to: its type, query language, ' +
        'and which tools to use. Call this first to decide between the SQL and MongoDB tools, and ' +
        'again whenever a tool reports a database-type mismatch (the connection can change mid-session).',
      inputSchema: {},
    },
    async () => {
      if (!isConnected()) {
        return toolJson({
          connected: false,
          message: 'No database is connected. Ask the user to connect one via the Helix UI.',
        });
      }
      const isMongo = getDriver().queryMode === 'mql';
      const cfg = getActiveConfig();
      return toolJson({
        connected: true,
        databaseType: cfg?.type ?? 'unknown',
        database: cfg?.database ?? null,
        queryLanguage: isMongo ? 'MongoDB (MQL)' : 'SQL',
        writesEnabled: isMcpWritesAllowed(),
        useTools: isMongo
          ? { read: MONGO_READ_TOOLS.split(', '), write: MONGO_WRITE_TOOLS.split(', ') }
          : { read: ['execute_query', 'list_tables', 'describe_table'], write: ['execute_write'] },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// SQL tools (MySQL / Postgres — queryMode 'sql')
// ---------------------------------------------------------------------------

function registerSqlTools(server: McpServer): void {
  server.registerTool(
    'list_tables',
    {
      description: '[SQL databases] List tables, views, procedures, and triggers in a schema. If no schema is given, lists schemas (databases).',
      inputSchema: {
        schema: z.string().optional().describe('Schema/database name. Omit to list available schemas.'),
      },
    },
    async ({ schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('sql');
      if (modeErr) return toolError(modeErr);

      try {
        const driver = getDriver();

        if (!schema) {
          const schemas = await driver.getSchemas();
          return toolJson({ schemas });
        }

        const info = await driver.getSchema(schema);
        return toolJson({
          schema,
          tables: info.tables.map(t => ({
            name: t.name,
            approxRows: t.rows,
            comment: t.comment,
          })),
          views: info.views,
        });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'describe_table',
    {
      description: '[SQL databases] Describe columns of a table: name, type, nullability, default, primary key, auto-increment.',
      inputSchema: {
        schema: z.string().describe('Schema/database name.'),
        table: z.string().describe('Table name.'),
      },
    },
    async ({ schema, table }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('sql');
      if (modeErr) return toolError(modeErr);

      try {
        const tableInfo = await getDriver().getTable(schema, table);
        if (!tableInfo) {
          return toolError(`Table "${schema}"."${table}" not found.`);
        }
        return toolJson({ schema, table, columns: tableInfo.columns });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'execute_query',
    {
      description:
        '[SQL databases] Run a read-only SQL query (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH). ' +
        `Results are capped at ${DEFAULT_ROW_LIMIT} rows by default; pass "limit" (up to ${MAX_ROW_LIMIT}) to change.`,
      inputSchema: {
        sql: z.string().min(1).describe('Read-only SQL statement.'),
        schema: z.string().optional().describe('Schema to switch to before the query.'),
        limit: z.number().int().positive().max(MAX_ROW_LIMIT).optional()
          .describe(`Max rows returned (default ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}).`),
      },
    },
    async ({ sql, schema, limit }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('sql');
      if (modeErr) return toolError(modeErr);

      const kw = firstKeyword(sql);
      if (!READ_KEYWORDS.has(kw)) {
        if (WRITE_KEYWORDS.has(kw)) {
          return toolError(`execute_query does not accept ${kw}. Use execute_write for data modifications.`);
        }
        return toolError(`execute_query only accepts read statements (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH). Got: ${kw || 'unknown'}.`);
      }

      const cap = limit ?? DEFAULT_ROW_LIMIT;
      try {
        const start = Date.now();
        const result = await getDriver().query(sql, [], schema);
        const executionTime = Date.now() - start;

        const columns = result.columnMeta.map(c => c.name);
        const totalRows = result.rows.length;
        const capped = result.rows.slice(0, cap);
        return toolJson({
          columns,
          rows: capped,
          rowCount: capped.length,
          totalRows,
          truncated: totalRows > capped.length,
          limitApplied: cap,
          executionTime,
        });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'execute_write',
    {
      description:
        '[SQL databases] Run an INSERT, UPDATE, DELETE, or REPLACE statement. ' +
        'Requires the user to have enabled "Allow MCP to modify data" in the Helix UI. ' +
        'DDL (CREATE/DROP/ALTER/TRUNCATE) is not supported.',
      inputSchema: {
        sql: z.string().min(1).describe('INSERT / UPDATE / DELETE / REPLACE statement.'),
        schema: z.string().optional().describe('Schema to switch to before the statement.'),
      },
    },
    async ({ sql, schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('sql');
      if (modeErr) return toolError(modeErr);

      if (!isMcpWritesAllowed()) {
        return toolError(
          'Writes are disabled. Ask the user to enable "Allow MCP to modify data" in the Helix UI (top-right menu).',
        );
      }

      const kw = firstKeyword(sql);
      if (!WRITE_KEYWORDS.has(kw)) {
        if (READ_KEYWORDS.has(kw)) {
          return toolError(`execute_write does not accept ${kw}. Use execute_query for reads.`);
        }
        return toolError(
          `execute_write only accepts INSERT/UPDATE/DELETE/REPLACE. DDL is not supported. Got: ${kw || 'unknown'}.`,
        );
      }

      try {
        const start = Date.now();
        const result = await getDriver().query(sql, [], schema);
        const executionTime = Date.now() - start;
        return toolJson({
          affectedRows: result.affectedRows ?? 0,
          insertId: result.insertId ?? null,
          executionTime,
        });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

// ---------------------------------------------------------------------------
// MongoDB tools (queryMode 'mql')
//
// The Mongo driver speaks a JSON-encoded MQL request (see drivers/mongodb.ts).
// Rather than make the model hand-author that JSON, each tool below exposes the
// individual MQL fields as typed parameters and assembles the request itself.
// ---------------------------------------------------------------------------

const docSchema = z.record(z.string(), z.unknown());

/** Build the JSON-encoded MQL request the Mongo driver's query() expects and run it. */
function runMql(req: Record<string, unknown>, schema?: string): Promise<QueryResult> {
  return getDriver().query(JSON.stringify(req), [], schema);
}

function registerMongoTools(server: McpServer): void {
  server.registerTool(
    'list_collections',
    {
      description:
        '[MongoDB] List collections (and views) in a database. ' +
        'If no database is given, lists the available databases.',
      inputSchema: {
        schema: z.string().optional().describe('Database name. Omit to list available databases.'),
      },
    },
    async ({ schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('mql');
      if (modeErr) return toolError(modeErr);

      try {
        const driver = getDriver();
        if (!schema) {
          const schemas = await driver.getSchemas();
          return toolJson({ databases: schemas });
        }
        const info = await driver.getSchema(schema);
        return toolJson({
          database: schema,
          collections: info.tables.map(t => ({ name: t.name, approxDocs: t.rows })),
          views: info.views,
        });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'describe_collection',
    {
      description:
        '[MongoDB] Describe a collection: field names and types inferred from a sample of documents ' +
        '(schemaless — fields may vary per document), plus its indexes and JSON Schema validator if set.',
      inputSchema: {
        schema: z.string().describe('Database name.'),
        collection: z.string().describe('Collection name.'),
      },
    },
    async ({ schema, collection }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('mql');
      if (modeErr) return toolError(modeErr);

      try {
        const driver = getDriver();
        const info = await driver.getTable(schema, collection);
        if (!info) {
          return toolError(`Collection "${schema}"."${collection}" not found.`);
        }
        const collInfo = await driver.getCollectionInfo?.(schema, collection) ?? null;
        return toolJson({
          database: schema,
          collection,
          approxDocs: info.rows,
          fields: info.columns,
          indexes: collInfo?.indexes ?? [],
          validator: collInfo?.validator ?? null,
        });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'find_documents',
    {
      description:
        '[MongoDB] Find documents in a collection (db.collection.find). ' +
        `Returns up to ${DEFAULT_ROW_LIMIT} documents by default; pass "limit" (up to ${MAX_ROW_LIMIT}) to change. ` +
        'Note: a string "_id" filter is matched literally and will not match an ObjectId — omit it or filter on other fields.',
      inputSchema: {
        collection: z.string().describe('Collection name.'),
        filter: docSchema.optional().describe('MongoDB query filter, e.g. {"status": "active"}. Omit for all documents.'),
        projection: docSchema.optional().describe('Fields to include/exclude, e.g. {"email": 1, "_id": 0}.'),
        sort: docSchema.optional().describe('Sort spec, e.g. {"createdAt": -1}.'),
        limit: z.number().int().positive().max(MAX_ROW_LIMIT).optional()
          .describe(`Max documents returned (default ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}).`),
        skip: z.number().int().nonnegative().optional().describe('Number of documents to skip.'),
        schema: z.string().optional().describe('Database name. Omit to use the connected database.'),
      },
    },
    async ({ collection, filter, projection, sort, limit, skip, schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('mql');
      if (modeErr) return toolError(modeErr);

      const cap = limit ?? DEFAULT_ROW_LIMIT;
      try {
        const start = Date.now();
        const result = await runMql(
          { collection, operation: 'find', filter, projection, sort, limit: cap, skip },
          schema,
        );
        const executionTime = Date.now() - start;
        return toolJson({
          fields: result.columnMeta.map(c => c.name),
          documents: result.rows,
          docCount: result.rows.length,
          limitApplied: cap,
          executionTime,
        });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'aggregate_documents',
    {
      description:
        '[MongoDB] Run an aggregation pipeline on a collection (db.collection.aggregate). ' +
        `Results are capped at ${DEFAULT_ROW_LIMIT} documents by default; pass "limit" (up to ${MAX_ROW_LIMIT}) to change. ` +
        'For large pipelines, add an explicit {"$limit": N} stage to bound work server-side.',
      inputSchema: {
        collection: z.string().describe('Collection name.'),
        pipeline: z.array(docSchema).describe('Aggregation pipeline stages, e.g. [{"$match": {...}}, {"$group": {...}}].'),
        limit: z.number().int().positive().max(MAX_ROW_LIMIT).optional()
          .describe(`Max documents returned (default ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}).`),
        schema: z.string().optional().describe('Database name. Omit to use the connected database.'),
      },
    },
    async ({ collection, pipeline, limit, schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('mql');
      if (modeErr) return toolError(modeErr);

      const cap = limit ?? DEFAULT_ROW_LIMIT;
      try {
        const start = Date.now();
        // Bound work server-side instead of fetching the whole result and
        // slicing in Node. Fetching one doc past the cap lets us still report
        // truncation without loading a potentially huge result set into memory,
        // mirroring how find_documents forwards its limit to the driver.
        const result = await runMql(
          { collection, operation: 'aggregate', pipeline: [...pipeline, { $limit: cap + 1 }] },
          schema,
        );
        const executionTime = Date.now() - start;
        const truncated = result.rows.length > cap;
        const documents = truncated ? result.rows.slice(0, cap) : result.rows;
        return toolJson({
          fields: result.columnMeta.map(c => c.name),
          documents,
          docCount: documents.length,
          truncated,
          limitApplied: cap,
          executionTime,
        });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'count_documents',
    {
      description: '[MongoDB] Count documents matching a filter in a collection (db.collection.countDocuments).',
      inputSchema: {
        collection: z.string().describe('Collection name.'),
        filter: docSchema.optional().describe('MongoDB query filter. Omit to count all documents.'),
        schema: z.string().optional().describe('Database name. Omit to use the connected database.'),
      },
    },
    async ({ collection, filter, schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('mql');
      if (modeErr) return toolError(modeErr);

      try {
        const start = Date.now();
        const result = await runMql({ collection, operation: 'count', filter }, schema);
        const executionTime = Date.now() - start;
        return toolJson({ count: result.rows[0]?.count ?? 0, executionTime });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'insert_document',
    {
      description:
        '[MongoDB] Insert a single document into a collection (db.collection.insertOne). ' +
        'Requires the user to have enabled "Allow MCP to modify data" in the Helix UI.',
      inputSchema: {
        collection: z.string().describe('Collection name.'),
        document: docSchema.describe('The document to insert.'),
        schema: z.string().optional().describe('Database name. Omit to use the connected database.'),
      },
    },
    async ({ collection, document, schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('mql');
      if (modeErr) return toolError(modeErr);
      if (!isMcpWritesAllowed()) {
        return toolError(
          'Writes are disabled. Ask the user to enable "Allow MCP to modify data" in the Helix UI (top-right menu).',
        );
      }

      try {
        const start = Date.now();
        const result = await runMql({ collection, operation: 'insertOne', document }, schema);
        const executionTime = Date.now() - start;
        return toolJson({ insertedCount: result.affectedRows ?? 0, executionTime });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'update_document',
    {
      description:
        '[MongoDB] Update a single document in a collection (db.collection.updateOne). ' +
        'Provide either "filter" or "id" to select the document, and "update" with operators like {"$set": {...}}. ' +
        'Requires the user to have enabled "Allow MCP to modify data" in the Helix UI.',
      inputSchema: {
        collection: z.string().describe('Collection name.'),
        update: docSchema.describe('Update document with operators, e.g. {"$set": {"status": "active"}}.'),
        filter: docSchema.optional().describe('Filter selecting the document to update.'),
        id: z.string().optional().describe('Convenience selector by _id (24-hex strings are matched as ObjectId, falling back to the raw value).'),
        schema: z.string().optional().describe('Database name. Omit to use the connected database.'),
      },
    },
    async ({ collection, update, filter, id, schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('mql');
      if (modeErr) return toolError(modeErr);
      if (!isMcpWritesAllowed()) {
        return toolError(
          'Writes are disabled. Ask the user to enable "Allow MCP to modify data" in the Helix UI (top-right menu).',
        );
      }
      if (filter === undefined && id === undefined) {
        return toolError('update_document requires either "filter" or "id" to select the document.');
      }

      try {
        const start = Date.now();
        const result = await runMql({ collection, operation: 'updateOne', update, filter, id }, schema);
        const executionTime = Date.now() - start;
        return toolJson({ matchedCount: result.affectedRows ?? 0, executionTime });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'delete_document',
    {
      description:
        '[MongoDB] Delete a single document from a collection (db.collection.deleteOne). ' +
        'Provide either "filter" or "id" to select the document. ' +
        'Requires the user to have enabled "Allow MCP to modify data" in the Helix UI.',
      inputSchema: {
        collection: z.string().describe('Collection name.'),
        filter: docSchema.optional().describe('Filter selecting the document to delete.'),
        id: z.string().optional().describe('Convenience selector by _id (24-hex strings are matched as ObjectId, falling back to the raw value).'),
        schema: z.string().optional().describe('Database name. Omit to use the connected database.'),
      },
    },
    async ({ collection, filter, id, schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);
      const modeErr = requireMode('mql');
      if (modeErr) return toolError(modeErr);
      if (!isMcpWritesAllowed()) {
        return toolError(
          'Writes are disabled. Ask the user to enable "Allow MCP to modify data" in the Helix UI (top-right menu).',
        );
      }
      if (filter === undefined && id === undefined) {
        return toolError('delete_document requires either "filter" or "id" to select the document.');
      }

      try {
        const start = Date.now();
        const result = await runMql({ collection, operation: 'deleteOne', filter, id }, schema);
        const executionTime = Date.now() - start;
        return toolJson({ deletedCount: result.affectedRows ?? 0, executionTime });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Server assembly
// ---------------------------------------------------------------------------

/**
 * Build the server instructions. The tool list is invariant — both the SQL and
 * MongoDB tools are always advertised — so the instructions explain that each
 * family only works against its database type, point at connection_info, and
 * name the database connected right now (which can change during a session).
 */
function buildInstructions(): string {
  const connected = isConnected();
  const cfg = getActiveConfig();
  const lines = [
    'Helix MCP exposes the database currently connected in the Helix UI.',
    'The same tools are always listed, but each only works against its database family: ' +
      `the SQL tools (${SQL_TOOLS}) require a SQL database, and the MongoDB tools ` +
      `(${MONGO_READ_TOOLS}, ${MONGO_WRITE_TOOLS}) require a MongoDB database.`,
    'Call connection_info first to learn which database is connected and which tools to use. ' +
      'The connection can change during a session, so re-check connection_info if a tool reports ' +
      'a database-type mismatch.',
  ];
  if (connected) {
    const isMongo = getDriver().queryMode === 'mql';
    lines.push(
      `Currently connected: a ${cfg?.type ?? 'unknown'} database — ` +
        `${isMongo ? 'use the MongoDB tools' : 'use the SQL tools'}.`,
    );
  } else {
    lines.push('Currently no database is connected.');
  }
  lines.push(
    'Writes are only allowed when the user has enabled "Allow MCP to modify data" in the Helix UI ' +
      'top-right menu. DDL (CREATE/DROP/ALTER/TRUNCATE/RENAME) is not supported.',
  );
  return lines.join(' ');
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'helix-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(),
    },
  );

  registerConnectionInfo(server);
  registerSqlTools(server);
  registerMongoTools(server);

  return server;
}

export const mcpHandler: RequestHandler = async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => { /* ignore */ });
    server.close().catch(() => { /* ignore */ });
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }
};

export function getMcpInfo(): { connected: boolean; writesAllowed: boolean; activeDatabase: string | null } {
  const cfg = getActiveConfig();
  return {
    connected: isConnected(),
    writesAllowed: isMcpWritesAllowed(),
    activeDatabase: cfg?.database ?? null,
  };
}

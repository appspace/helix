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

// ---------------------------------------------------------------------------
// SQL tools (MySQL / Postgres — queryMode 'sql')
// ---------------------------------------------------------------------------

function registerSqlTools(server: McpServer): void {
  server.registerTool(
    'list_tables',
    {
      description: 'List tables, views, procedures, and triggers in a schema. If no schema is given, lists schemas (databases).',
      inputSchema: {
        schema: z.string().optional().describe('Schema/database name. Omit to list available schemas.'),
      },
    },
    async ({ schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);

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
      description: 'Describe columns of a table: name, type, nullability, default, primary key, auto-increment.',
      inputSchema: {
        schema: z.string().describe('Schema/database name.'),
        table: z.string().describe('Table name.'),
      },
    },
    async ({ schema, table }) => {
      const err = requireConnection();
      if (err) return toolError(err);

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
        'Run a read-only SQL query (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH). ' +
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
        'Run an INSERT, UPDATE, DELETE, or REPLACE statement. ' +
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
        'List collections (and views) in a MongoDB database. ' +
        'If no database is given, lists the available databases.',
      inputSchema: {
        schema: z.string().optional().describe('Database name. Omit to list available databases.'),
      },
    },
    async ({ schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);

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
        'Describe a MongoDB collection: field names and types inferred from a sample of documents ' +
        '(schemaless — fields may vary per document), plus its indexes and JSON Schema validator if set.',
      inputSchema: {
        schema: z.string().describe('Database name.'),
        collection: z.string().describe('Collection name.'),
      },
    },
    async ({ schema, collection }) => {
      const err = requireConnection();
      if (err) return toolError(err);

      try {
        const driver = getDriver();
        const info = await driver.getTable(schema, collection);
        if (!info) {
          return toolError(`Collection "${schema}"."${collection}" not found.`);
        }
        const collInfo = driver.getCollectionInfo
          ? await driver.getCollectionInfo(schema, collection)
          : null;
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
        'Find documents in a MongoDB collection (db.collection.find). ' +
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
        'Run an aggregation pipeline on a MongoDB collection (db.collection.aggregate). ' +
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

      const cap = limit ?? DEFAULT_ROW_LIMIT;
      try {
        const start = Date.now();
        const result = await runMql({ collection, operation: 'aggregate', pipeline }, schema);
        const executionTime = Date.now() - start;
        const totalRows = result.rows.length;
        const capped = result.rows.slice(0, cap);
        return toolJson({
          fields: result.columnMeta.map(c => c.name),
          documents: capped,
          docCount: capped.length,
          totalDocs: totalRows,
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
    'count_documents',
    {
      description: 'Count documents matching a filter in a MongoDB collection (db.collection.countDocuments).',
      inputSchema: {
        collection: z.string().describe('Collection name.'),
        filter: docSchema.optional().describe('MongoDB query filter. Omit to count all documents.'),
        schema: z.string().optional().describe('Database name. Omit to use the connected database.'),
      },
    },
    async ({ collection, filter, schema }) => {
      const err = requireConnection();
      if (err) return toolError(err);

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
        'Insert a single document into a MongoDB collection (db.collection.insertOne). ' +
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
        'Update a single document in a MongoDB collection (db.collection.updateOne). ' +
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
        'Delete a single document from a MongoDB collection (db.collection.deleteOne). ' +
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
 * The active query language for the connected database. Defaults to 'sql' when
 * nothing is connected so the (backward-compatible) SQL toolset is advertised.
 * The transport is stateless, so `tools/list` is re-evaluated on every request
 * and always reflects the database connected at that moment.
 */
function activeQueryMode(): 'sql' | 'mql' {
  return isConnected() ? getDriver().queryMode : 'sql';
}

function buildInstructions(mode: 'sql' | 'mql'): string {
  const cfg = getActiveConfig();
  const dbType = cfg?.type ?? 'none';
  const base = [
    'Helix MCP exposes the database currently connected in the Helix UI.',
    `The connected database is ${isConnected() ? `a ${dbType} database` : 'not connected yet'}.`,
  ];
  if (mode === 'mql') {
    base.push(
      'This is a MongoDB (document) database — use the MongoDB tools (find_documents, aggregate_documents, count_documents, ...).',
      'Do NOT write SQL: there are no SELECT/SHOW statements here, only collections and documents.',
      'Writes (insert/update/delete) are only allowed when the user has enabled "Allow MCP to modify data" in the Helix UI top-right menu.',
    );
  } else {
    base.push(
      'This is a SQL database — use SQL via execute_query (reads) and execute_write (writes).',
      'Writes (INSERT/UPDATE/DELETE/REPLACE) are only allowed when the user has enabled "Allow MCP to modify data" in the Helix UI top-right menu.',
      'DDL (CREATE/DROP/ALTER/TRUNCATE/RENAME) is not supported in this version.',
    );
  }
  return base.join(' ');
}

export function buildMcpServer(): McpServer {
  const mode = activeQueryMode();
  const server = new McpServer(
    { name: 'helix-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(mode),
    },
  );

  if (mode === 'mql') {
    registerMongoTools(server);
  } else {
    registerSqlTools(server);
  }

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

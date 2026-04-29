import type { RequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getDriver, getActiveConfig, isConnected } from './db.js';
import { isMcpWritesAllowed } from './mcp-state.js';

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

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'helix-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: [
        'Helix MCP exposes the database currently connected in the Helix UI.',
        'Reads are always allowed. Writes (INSERT/UPDATE/DELETE/REPLACE) are only allowed',
        'when the user has explicitly enabled them in the Helix UI top-right menu.',
        'DDL (CREATE/DROP/ALTER/TRUNCATE/RENAME) is not supported in this version.',
      ].join(' '),
    },
  );

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

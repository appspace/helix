import type { QueryResults } from './components/ResultsTable';

export interface SchemaColumn {
  name: string;
  type: string;
  dataType: string;
  pk: boolean;
  nullable: boolean;
  default: string | null;
  autoIncrement: boolean;
  comment: string;
}

export interface SchemaTable {
  name: string;
  rows: number;
  comment: string;
  columns: SchemaColumn[];
}

export interface SchemaData {
  tables: SchemaTable[];
  views: string[];
  procedures: string[];
  triggers: string[];
}

export type ObjectType = 'table' | 'view' | 'procedure' | 'trigger';

export interface ColumnMeta {
  name: string;
  orgName: string;
  table: string;
  orgTable: string;
  pk: boolean;
  unique: boolean;
  notNull: boolean;
  mysqlType: number;
}

export interface DeleteRowWhere {
  column: string;
  value: string | number | boolean | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json() as T & { error?: string };
  if (!res.ok) {
    const msg = (body as { error?: string }).error?.trim();
    throw new Error(msg || `Request failed with HTTP ${res.status}`);
  }
  return body;
}

export const api = {
  connect(form: { host: string; port: string; user: string; password: string; database: string; ssl: boolean; sslVerify: boolean }) {
    const { ssl, sslVerify, ...rest } = form;
    const sslMode = !ssl ? undefined : sslVerify ? 'verify-full' : 'require';
    return request<{ ok: boolean; connectionName: string }>('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ ...rest, port: Number(form.port), ssl: sslMode }),
    });
  },

  testConnection(form: { host: string; port: string; user: string; password: string; database: string; ssl: boolean; sslVerify: boolean }) {
    const { ssl, sslVerify, ...rest } = form;
    const sslMode = !ssl ? undefined : sslVerify ? 'verify-full' : 'require';
    return request<{ ok: boolean }>('/api/connect/test', {
      method: 'POST',
      body: JSON.stringify({ ...rest, port: Number(form.port), ssl: sslMode }),
    });
  },

  disconnect() {
    return request<{ ok: boolean }>('/api/connect', { method: 'DELETE' });
  },

  status() {
    return request<{ connected: boolean; connectionName: string | null }>('/api/connect/status');
  },

  schemas() {
    return request<{ schemas: string[] }>('/api/schemas');
  },

  schema(schema: string) {
    return request<SchemaData>(`/api/schema?schema=${encodeURIComponent(schema)}`);
  },

  tableDdl(schema: string, name: string, type?: ObjectType) {
    const t = type ? `&type=${encodeURIComponent(type)}` : '';
    return request<{ ddl: string }>(`/api/table-ddl?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(name)}${t}`);
  },

  query(sql: string, schema: string) {
    return request<QueryResults & { columnMeta?: ColumnMeta[]; executionTime: number; affectedRows?: number; insertId?: number }>(
      '/api/query',
      { method: 'POST', body: JSON.stringify({ sql, schema }) }
    );
  },

  deleteRow(schema: string, table: string, where: DeleteRowWhere[]) {
    return request<{ affectedRows: number; sql: string }>('/api/delete-row', {
      method: 'POST',
      body: JSON.stringify({ schema, table, where }),
    });
  },

  updateCell(schema: string, table: string, where: DeleteRowWhere[], column: string, value: string | number | boolean | null) {
    return request<{ affectedRows: number; changedRows: number; sql: string }>('/api/update-cell', {
      method: 'POST',
      body: JSON.stringify({ schema, table, where, column, value }),
    });
  },

  insertRow(schema: string, table: string, values: Record<string, string | number | boolean | null>) {
    return request<{ affectedRows: number; insertId: number | null; sql: string }>('/api/insert-row', {
      method: 'POST',
      body: JSON.stringify({ schema, table, values }),
    });
  },

  dropTable(schema: string, table: string) {
    return request<{ ok: boolean; sql: string }>('/api/drop-table', {
      method: 'POST',
      body: JSON.stringify({ schema, table }),
    });
  },

  mcpStatus() {
    return request<{ connected: boolean; writesAllowed: boolean; mcpUrl: string }>('/api/mcp/status');
  },

  setMcpWrites(enabled: boolean) {
    return request<{ writesAllowed: boolean }>('/api/mcp/writes', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  },

};

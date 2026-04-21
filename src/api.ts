import type { QueryResults } from './components/ResultsTable';

export interface SchemaData {
  tables: { name: string; rows: number; columns: { name: string; type: string; pk: boolean }[] }[];
  views: string[];
  procedures: string[];
  triggers: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body;
}

export const api = {
  connect(form: { host: string; port: string; user: string; password: string; database: string; ssl: boolean }) {
    return request<{ ok: boolean; connectionName: string }>('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ ...form, port: Number(form.port) }),
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

  query(sql: string, schema: string) {
    return request<QueryResults & { executionTime: number; affectedRows?: number; insertId?: number }>(
      '/api/query',
      { method: 'POST', body: JSON.stringify({ sql, schema }) }
    );
  },
};

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  ssl?: 'require' | 'verify-full';
  type: 'mysql' | 'postgres';
}

export interface ColumnMeta {
  name: string;
  orgName: string;
  table: string;
  orgTable: string;
  pk: boolean;
  unique: boolean;
  notNull: boolean;
  /** MySQL column type constant; 0 for non-MySQL drivers. */
  mysqlType: number;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  columnMeta: ColumnMeta[];
  affectedRows?: number;
  insertId?: number | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
  dataType: string;
  pk: boolean;
  nullable: boolean;
  default: string | null;
  autoIncrement: boolean;
  comment: string;
}

export interface TableInfo {
  name: string;
  rows: number;
  comment: string;
  columns: ColumnInfo[];
}

export interface SchemaInfo {
  tables: TableInfo[];
  views: string[];
  procedures: string[];
  triggers: string[];
}

export interface DbDriver {
  /** Run a query, optionally switching schema first (atomically on one connection). */
  query(sql: string, params?: unknown[], schema?: string): Promise<QueryResult>;
  getSchemas(): Promise<string[]>;
  getSchema(schema: string): Promise<SchemaInfo>;
  getTableDdl(schema: string, table: string, type: 'table' | 'view' | 'procedure' | 'trigger'): Promise<string>;
  /** Return a quoted, escaped identifier (e.g. `name` for MySQL, "name" for Postgres). */
  escapeIdent(s: string): string;
  /** " LIMIT N" for dialects that support it in DML; "" for those that don't (e.g. Postgres). */
  rowLimitClause(n: number): string;
  ping(): Promise<void>;
  end(): Promise<void>;
}

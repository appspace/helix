export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  ssl?: 'require' | 'verify-full';
  type: 'mysql' | 'postgres' | 'mongodb';
  /** When set, drivers that support it (e.g. MongoDB) use this URI instead of building one from host/port/user/password. */
  connectionString?: string;
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
  /** Set by document-store drivers when fields are inferred from a sample document. */
  inferred?: boolean;
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

/**
 * Collection-level metadata for document stores (MongoDB).
 * Replaces `getTableDdl` for drivers in `mql` mode.
 */
export interface CollectionInfo {
  /** JSON Schema validator if one is set on the collection; null otherwise. */
  validator: Record<string, unknown> | null;
  /** Indexes as returned by the underlying driver (e.g. `collection.indexes()`). */
  indexes: Record<string, unknown>[];
}

export interface DbDriver {
  /**
   * Drivers in `sql` mode accept a SQL string + params; drivers in `mql` mode
   * accept a MQL request object. Routes branch on this to validate the body shape.
   */
  readonly queryMode: 'sql' | 'mql';
  /** Run a query, optionally switching schema first (atomically on one connection). */
  query(sql: string, params?: unknown[], schema?: string): Promise<QueryResult>;
  /**
   * Run one or more semicolon-separated statements and return a result per statement.
   * Implemented by sql-mode drivers; mql-mode drivers can omit it.
   */
  queryAll?(sql: string, schema?: string): Promise<QueryResult[]>;
  getSchemas(): Promise<string[]>;
  getSchema(schema: string): Promise<SchemaInfo>;
  /** Targeted lookup for a single table — returns null if it doesn't exist. */
  getTable(schema: string, table: string): Promise<TableInfo | null>;
  getTableDdl(schema: string, table: string, type: 'table' | 'view' | 'procedure' | 'trigger'): Promise<string>;
  /** Document-store equivalent of `getTableDdl`. Implemented by `mql`-mode drivers. Returns null when the collection doesn't exist. */
  getCollectionInfo?(schema: string, collection: string): Promise<CollectionInfo | null>;
  /** Return a quoted, escaped identifier (e.g. `name` for MySQL, "name" for Postgres). */
  escapeIdent(s: string): string;
  /** " LIMIT N" for dialects that support it in DML; "" for those that don't (e.g. Postgres). */
  rowLimitClause(n: number): string;
  ping(): Promise<void>;
  /**
   * Drop and rebuild any underlying connection pool. Called after the host
   * machine resumes from sleep so the next query opens a fresh socket instead
   * of using a dead one the OS still thinks is open. Drivers that don't pool
   * (or self-heal) may omit this — e.g. MongoDB's SDAM monitor heartbeats every
   * `heartbeatFrequencyMS` and re-establishes dead servers on its own.
   */
  recyclePool?(): Promise<void>;
  end(): Promise<void>;
}

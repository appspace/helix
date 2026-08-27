import mysql from 'mysql2/promise';
import type { RowDataPacket, FieldPacket, ResultSetHeader } from 'mysql2/promise';
import type { DbDriver, ConnectionConfig, QueryResult, ColumnMeta, ColumnInfo, ForeignKeyInfo, IndexInfo, SchemaInfo, TableInfo } from './interface.js';

function buildMysqlPoolOptions(config: ConnectionConfig): mysql.PoolOptions {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database || undefined,
    ssl: config.ssl === 'verify-full' ? { rejectUnauthorized: true }
       : config.ssl === 'require'     ? { rejectUnauthorized: false }
       : undefined,
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10_000,
    multipleStatements: true,
    // Return DATE / DATETIME / TIMESTAMP as raw strings rather than JS Dates.
    // mysql2's default coerces them through `new Date(...)`, which interprets
    // the value in the Node process's local timezone and then loses TZ on the
    // way out — a row written as "2026-05-07 10:00:00" comes back several hours
    // skewed in any process whose TZ differs from where it was written.
    // Helix is a DB browser; surface the literal value, don't reinterpret.
    dateStrings: true,
    // OS-level TCP keepalive — without this, dead sockets after macOS sleep
    // are only surfaced by the kernel's default ~2-hour timer, which causes
    // the first post-resume query to hang. See #145.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  };
}

const MYSQL_NOT_NULL_FLAG = 1;
const MYSQL_PRI_KEY_FLAG = 2;
const MYSQL_UNIQUE_KEY_FLAG = 4;
const MYSQL_TYPE_BIT = 16;

function buildMysqlResult(rows: RowDataPacket[] | ResultSetHeader, fields: FieldPacket[]): QueryResult {
  if (!Array.isArray(rows)) {
    const result = rows as ResultSetHeader;
    return {
      rows: [],
      columnMeta: [],
      affectedRows: result.affectedRows ?? 0,
      insertId: result.insertId ?? null,
    };
  }

  const bitColumns = new Set<string>();
  for (const f of fields) {
    if ((f.columnType ?? f.type) === MYSQL_TYPE_BIT) bitColumns.add(f.name);
  }

  const columnMeta: ColumnMeta[] = fields.map(f => {
    let flagsNum = 0;
    if (typeof f.flags === 'number') {
      flagsNum = f.flags;
    } else if (Array.isArray(f.flags)) {
      if ((f.flags as string[]).includes('NOT_NULL')) flagsNum |= MYSQL_NOT_NULL_FLAG;
      if ((f.flags as string[]).includes('PRI_KEY')) flagsNum |= MYSQL_PRI_KEY_FLAG;
      if ((f.flags as string[]).includes('UNIQUE_KEY')) flagsNum |= MYSQL_UNIQUE_KEY_FLAG;
    }
    return {
      name: f.name,
      orgName: f.orgName ?? f.name,
      table: f.table ?? '',
      orgTable: f.orgTable ?? '',
      pk: (flagsNum & MYSQL_PRI_KEY_FLAG) === MYSQL_PRI_KEY_FLAG,
      unique: (flagsNum & MYSQL_UNIQUE_KEY_FLAG) === MYSQL_UNIQUE_KEY_FLAG,
      notNull: (flagsNum & MYSQL_NOT_NULL_FLAG) === MYSQL_NOT_NULL_FLAG,
      mysqlType: f.columnType ?? f.type ?? 0,
    };
  });

  const columns = fields.map(f => f.name);
  const serializedRows = (rows as RowDataPacket[]).map(row => {
    const out: Record<string, unknown> = {};
    for (const col of columns) {
      const val = row[col];
      if (val === null || val === undefined) {
        out[col] = null;
      } else if (Buffer.isBuffer(val)) {
        if (bitColumns.has(col) && val.length <= 6) {
          let n = 0;
          for (const byte of val) n = n * 256 + byte;
          out[col] = n;
        } else {
          out[col] = val.toString('hex');
        }
      } else if (val instanceof Date) {
        out[col] = val.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
      } else if (typeof val === 'bigint') {
        out[col] = val.toString();
      } else {
        out[col] = val;
      }
    }
    return out;
  });

  return { rows: serializedRows, columnMeta };
}

/**
 * Fold information_schema.STATISTICS rows — one per (index, column) pair — into
 * one `IndexInfo` per index, keyed by table. Callers must order the rows by
 * SEQ_IN_INDEX so `columns` comes out in index order; that order is what
 * decides whether a query can use the index. NON_UNIQUE is inverted (0 =
 * unique), and MySQL 8 functional index parts carry a NULL COLUMN_NAME.
 */
function groupMysqlIndexes(rows: RowDataPacket[]): Map<string, IndexInfo[]> {
  const byTable = new Map<string, IndexInfo[]>();
  for (const row of rows) {
    const tname = row['tbl'] as string;
    const iname = row['idx'] as string;
    if (!byTable.has(tname)) byTable.set(tname, []);
    const list = byTable.get(tname)!;
    let idx = list.find(i => i.name === iname);
    if (!idx) {
      idx = {
        name: iname,
        unique: Number(row['non_unique']) === 0,
        columns: [],
        type: (row['idx_type'] as string) ?? '',
      };
      list.push(idx);
    }
    idx.columns.push((row['col'] as string | null) ?? '(expression)');
  }
  return byTable;
}

/**
 * Fold information_schema.KEY_COLUMN_USAGE rows — one per (constraint, column)
 * pair — into one `ForeignKeyInfo` per constraint, keyed by table. Callers must
 * filter to `REFERENCED_TABLE_NAME IS NOT NULL` (the same view also holds PK and
 * unique constraints) and order by ORDINAL_POSITION, so a composite key's
 * columns line up with the columns they reference.
 */
function groupMysqlForeignKeys(rows: RowDataPacket[]): Map<string, ForeignKeyInfo[]> {
  const byTable = new Map<string, ForeignKeyInfo[]>();
  for (const row of rows) {
    const tname = row['tbl'] as string;
    const cname = row['name'] as string;
    if (!byTable.has(tname)) byTable.set(tname, []);
    const list = byTable.get(tname)!;
    let fk = list.find(f => f.name === cname);
    if (!fk) {
      fk = {
        name: cname,
        columns: [],
        referencedSchema: (row['ref_schema'] as string) ?? '',
        referencedTable: (row['ref_tbl'] as string) ?? '',
        referencedColumns: [],
      };
      list.push(fk);
    }
    fk.columns.push(row['col'] as string);
    fk.referencedColumns.push(row['ref_col'] as string);
  }
  return byTable;
}

const MYSQL_FK_SELECT = `SELECT TABLE_NAME AS tbl, CONSTRAINT_NAME AS name, COLUMN_NAME AS col,
                  REFERENCED_TABLE_SCHEMA AS ref_schema, REFERENCED_TABLE_NAME AS ref_tbl,
                  REFERENCED_COLUMN_NAME AS ref_col
           FROM information_schema.KEY_COLUMN_USAGE`;

export class MysqlDriver implements DbDriver {
  readonly queryMode = 'sql' as const;
  private pool: mysql.Pool;
  private config: ConnectionConfig;
  private recycling: Promise<void> | null = null;

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.pool = mysql.createPool(buildMysqlPoolOptions(config));
  }

  /**
   * Drop the current pool and rebuild it from the saved config. Used after the
   * machine resumes from sleep — every pre-existing socket is dead but the
   * pool would happily hand it back to the next query, hanging the request.
   *
   * Bursty resume events (sleep → brief wake → sleep) can fire `host-resumed`
   * twice in quick succession; the in-flight guard makes the call idempotent
   * so we don't orphan a freshly-built pool.
   */
  recyclePool(): Promise<void> {
    if (this.recycling) return this.recycling;
    const old = this.pool;
    this.pool = mysql.createPool(buildMysqlPoolOptions(this.config));
    // Fire-and-forget the old pool: its sockets are likely dead, and mysql2's
    // `end()` waits for the socket close to be acknowledged — awaiting here
    // would reintroduce the very hang we're trying to fix.
    void old.end().catch(() => { /* dead sockets — nothing to do */ });
    // Pre-warm so the user's next query doesn't pay TCP+auth on top of the
    // resume itself. Also fire-and-forget — failure here is benign because
    // the next query will retry the connect.
    this.recycling = this.pool
      .getConnection()
      .then(c => c.release())
      .catch(() => { /* will surface on the user's next query */ })
      .finally(() => { this.recycling = null; });
    return this.recycling;
  }

  escapeIdent(s: string): string {
    return '`' + s.replace(/`/g, '') + '`';
  }

  rowLimitClause(n: number): string {
    return ` LIMIT ${n}`;
  }

  async ping(): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.ping();
    } finally {
      conn.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  async query(sql: string, params?: unknown[], schema?: string): Promise<QueryResult> {
    const conn = await this.pool.getConnection();
    try {
      if (schema) {
        await conn.query(`USE \`${schema.replace(/`/g, '')}\``);
      }

      const [rows, fields] = await conn.query(sql, params) as [RowDataPacket[] | ResultSetHeader, FieldPacket[]];
      // With multipleStatements enabled, mysql2 returns arrays-of-arrays when
      // the SQL contains more than one statement. Internal callers (insertRow,
      // updateCell, deleteRow, …) only ever pass single statements, so flatten
      // the multi-result shape down to the first set here for the legacy contract.
      // Multi-statement user input goes through `queryAll` instead.
      if (Array.isArray(rows) && rows.length > 0 && Array.isArray((rows as unknown[])[0])) {
        const firstRows = (rows as unknown as RowDataPacket[][])[0];
        const firstFields = (fields as unknown as FieldPacket[][])[0] ?? [];
        return buildMysqlResult(firstRows, firstFields);
      }
      return buildMysqlResult(rows, fields);
    } finally {
      conn.release();
    }
  }

  async queryAll(sql: string, schema?: string): Promise<QueryResult[]> {
    const conn = await this.pool.getConnection();
    try {
      if (schema) {
        await conn.query(`USE \`${schema.replace(/`/g, '')}\``);
      }
      const [rawRows, rawFields] = await conn.query(sql) as [
        RowDataPacket[] | ResultSetHeader | (RowDataPacket[] | ResultSetHeader)[],
        FieldPacket[] | FieldPacket[][],
      ];
      // Single statement: mysql2 returns the result directly. Multi-statement: it
      // returns parallel arrays — one rowset and one fields array per statement.
      const isMulti = Array.isArray(rawRows) && rawRows.length > 0 && Array.isArray((rawRows as unknown[])[0]);
      if (!isMulti) {
        return [buildMysqlResult(rawRows as RowDataPacket[] | ResultSetHeader, rawFields as FieldPacket[])];
      }
      const rowSets = rawRows as (RowDataPacket[] | ResultSetHeader)[];
      const fieldSets = rawFields as FieldPacket[][];
      return rowSets.map((r, i) => buildMysqlResult(r, fieldSets[i] ?? []));
    } finally {
      conn.release();
    }
  }

  async getSchemas(): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys')
       ORDER BY SCHEMA_NAME`,
    );
    return rows.map(r => r['name'] as string);
  }

  async getSchema(schema: string): Promise<SchemaInfo> {
    const conn = await this.pool.getConnection();
    try {
      const [[tables], [columns], [indexes], [fks], [views], [procedures], [triggers]] = await Promise.all([
        conn.query<RowDataPacket[]>(
          `SELECT TABLE_NAME AS name, TABLE_ROWS AS row_count, TABLE_COMMENT AS comment
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
           ORDER BY TABLE_NAME`,
          [schema],
        ),
        conn.query<RowDataPacket[]>(
          `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, COLUMN_TYPE AS col_type,
                  DATA_TYPE AS data_type,
                  IF(COLUMN_KEY = 'PRI', 1, 0) AS is_pk,
                  IF(IS_NULLABLE = 'YES', 1, 0) AS nullable,
                  COLUMN_DEFAULT AS col_default,
                  EXTRA AS extra,
                  COLUMN_COMMENT AS comment
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ?
           ORDER BY TABLE_NAME, ORDINAL_POSITION`,
          [schema],
        ),
        conn.query<RowDataPacket[]>(
          `SELECT TABLE_NAME AS tbl, INDEX_NAME AS idx, COLUMN_NAME AS col,
                  NON_UNIQUE AS non_unique, INDEX_TYPE AS idx_type
           FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = ?
           ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
          [schema],
        ),
        conn.query<RowDataPacket[]>(
          `${MYSQL_FK_SELECT}
           WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
           ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
          [schema],
        ),
        conn.query<RowDataPacket[]>(
          `SELECT TABLE_NAME AS name FROM information_schema.VIEWS
           WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
          [schema],
        ),
        conn.query<RowDataPacket[]>(
          `SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES
           WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'
           ORDER BY ROUTINE_NAME`,
          [schema],
        ),
        conn.query<RowDataPacket[]>(
          `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
           WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
          [schema],
        ),
      ]);

      const colsByTable = new Map<string, ColumnInfo[]>();
      for (const col of columns) {
        const tname = col['tbl'] as string;
        if (!colsByTable.has(tname)) colsByTable.set(tname, []);
        const extra = ((col['extra'] as string) ?? '').toLowerCase();
        colsByTable.get(tname)!.push({
          name: col['col'] as string,
          type: col['col_type'] as string,
          dataType: ((col['data_type'] as string) ?? '').toLowerCase(),
          pk: Boolean(col['is_pk']),
          nullable: Boolean(col['nullable']),
          default: (col['col_default'] as string | null) ?? null,
          autoIncrement: extra.includes('auto_increment'),
          comment: (col['comment'] as string) ?? '',
        });
      }

      const indexesByTable = groupMysqlIndexes(indexes);
      const fksByTable = groupMysqlForeignKeys(fks);

      return {
        tables: tables.map(t => ({
          name: t['name'] as string,
          rows: t['row_count'] as number,
          comment: (t['comment'] as string) ?? '',
          columns: colsByTable.get(t['name'] as string) ?? [],
          indexes: indexesByTable.get(t['name'] as string) ?? [],
          foreignKeys: fksByTable.get(t['name'] as string) ?? [],
        })),
        views: views.map(v => v['name'] as string),
        procedures: procedures.map(p => p['name'] as string),
        triggers: triggers.map(t => t['name'] as string),
      };
    } finally {
      conn.release();
    }
  }

  async getTable(schema: string, table: string): Promise<TableInfo | null> {
    const conn = await this.pool.getConnection();
    try {
      const [[tables], [columns], [indexes], [fks]] = await Promise.all([
        conn.query<RowDataPacket[]>(
          `SELECT TABLE_NAME AS name, TABLE_ROWS AS row_count, TABLE_COMMENT AS comment
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'`,
          [schema, table],
        ),
        conn.query<RowDataPacket[]>(
          `SELECT COLUMN_NAME AS col, COLUMN_TYPE AS col_type,
                  DATA_TYPE AS data_type,
                  IF(COLUMN_KEY = 'PRI', 1, 0) AS is_pk,
                  IF(IS_NULLABLE = 'YES', 1, 0) AS nullable,
                  COLUMN_DEFAULT AS col_default,
                  EXTRA AS extra,
                  COLUMN_COMMENT AS comment
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`,
          [schema, table],
        ),
        conn.query<RowDataPacket[]>(
          `SELECT TABLE_NAME AS tbl, INDEX_NAME AS idx, COLUMN_NAME AS col,
                  NON_UNIQUE AS non_unique, INDEX_TYPE AS idx_type
           FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
          [schema, table],
        ),
        conn.query<RowDataPacket[]>(
          `${MYSQL_FK_SELECT}
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
           ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
          [schema, table],
        ),
      ]);

      if (tables.length === 0) return null;
      const t = tables[0];
      const cols: ColumnInfo[] = columns.map(col => {
        const extra = ((col['extra'] as string) ?? '').toLowerCase();
        return {
          name: col['col'] as string,
          type: col['col_type'] as string,
          dataType: ((col['data_type'] as string) ?? '').toLowerCase(),
          pk: Boolean(col['is_pk']),
          nullable: Boolean(col['nullable']),
          default: (col['col_default'] as string | null) ?? null,
          autoIncrement: extra.includes('auto_increment'),
          comment: (col['comment'] as string) ?? '',
        };
      });
      return {
        name: t['name'] as string,
        rows: t['row_count'] as number,
        comment: (t['comment'] as string) ?? '',
        columns: cols,
        indexes: groupMysqlIndexes(indexes).get(table) ?? [],
        foreignKeys: groupMysqlForeignKeys(fks).get(table) ?? [],
      };
    } finally {
      conn.release();
    }
  }

  async getTableDdl(schema: string, table: string, type: 'table' | 'view' | 'procedure' | 'trigger'): Promise<string> {
    const qualified = `${this.escapeIdent(schema)}.${this.escapeIdent(table)}`;

    let sql: string;
    if (type === 'procedure') {
      sql = `SHOW CREATE PROCEDURE ${qualified}`;
    } else if (type === 'trigger') {
      sql = `SHOW CREATE TRIGGER ${qualified}`;
    } else {
      sql = `SHOW CREATE TABLE ${qualified}`;
    }

    const [rows] = await this.pool.query<RowDataPacket[]>(sql);
    if (rows.length === 0) throw new Error(`No DDL returned for ${qualified}.`);

    const row = rows[0] as Record<string, unknown>;
    return (
      row['Create Table'] ??
      row['Create View'] ??
      row['Create Procedure'] ??
      row['SQL Original Statement'] ??
      ''
    ) as string;
  }
}

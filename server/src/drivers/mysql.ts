import mysql from 'mysql2/promise';
import type { RowDataPacket, FieldPacket, ResultSetHeader } from 'mysql2/promise';
import type { DbDriver, ConnectionConfig, QueryResult, ColumnMeta, ColumnInfo, SchemaInfo, TableInfo } from './interface.js';

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
    // OS-level TCP keepalive — without this, dead sockets after macOS sleep
    // are only surfaced by the kernel's default ~2-hour timer, which causes
    // the first post-resume query to hang. See #145.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  };
}

export class MysqlDriver implements DbDriver {
  readonly queryMode = 'sql' as const;
  private pool: mysql.Pool;

  private config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.pool = mysql.createPool(buildMysqlPoolOptions(config));
  }

  /**
   * Drop the current pool and rebuild it from the saved config. Used after the
   * machine resumes from sleep — every pre-existing socket is dead but the
   * pool would happily hand it back to the next query, hanging the request.
   */
  async recyclePool(): Promise<void> {
    const old = this.pool;
    this.pool = mysql.createPool(buildMysqlPoolOptions(this.config));
    try { await old.end(); } catch { /* old pool sockets are likely dead — swallow */ }
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

      if (!Array.isArray(rows)) {
        const result = rows as ResultSetHeader;
        return {
          rows: [],
          columnMeta: [],
          affectedRows: result.affectedRows ?? 0,
          insertId: result.insertId ?? null,
        };
      }

      const NOT_NULL_FLAG = 1;
      const PRI_KEY_FLAG = 2;
      const UNIQUE_KEY_FLAG = 4;

      const columnMeta: ColumnMeta[] = fields.map(f => {
        let flagsNum = 0;
        if (typeof f.flags === 'number') {
          flagsNum = f.flags;
        } else if (Array.isArray(f.flags)) {
          if ((f.flags as string[]).includes('NOT_NULL')) flagsNum |= NOT_NULL_FLAG;
          if ((f.flags as string[]).includes('PRI_KEY')) flagsNum |= PRI_KEY_FLAG;
          if ((f.flags as string[]).includes('UNIQUE_KEY')) flagsNum |= UNIQUE_KEY_FLAG;
        }
        return {
          name: f.name,
          orgName: f.orgName ?? f.name,
          table: f.table ?? '',
          orgTable: f.orgTable ?? '',
          pk: (flagsNum & PRI_KEY_FLAG) === PRI_KEY_FLAG,
          unique: (flagsNum & UNIQUE_KEY_FLAG) === UNIQUE_KEY_FLAG,
          notNull: (flagsNum & NOT_NULL_FLAG) === NOT_NULL_FLAG,
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
            out[col] = val.toString('hex');
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
      const [[tables], [columns], [views], [procedures], [triggers]] = await Promise.all([
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

      return {
        tables: tables.map(t => ({
          name: t['name'] as string,
          rows: t['row_count'] as number,
          comment: (t['comment'] as string) ?? '',
          columns: colsByTable.get(t['name'] as string) ?? [],
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
      const [[tables], [columns]] = await Promise.all([
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

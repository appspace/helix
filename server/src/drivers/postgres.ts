import pg from 'pg';
import type { DbDriver, ConnectionConfig, QueryResult, ColumnMeta, ColumnInfo, SchemaInfo, TableInfo } from './interface.js';

export class PostgresDriver implements DbDriver {
  private pool: pg.Pool;

  constructor(config: ConnectionConfig) {
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database || undefined,
      ssl: config.ssl === 'verify-full' ? { rejectUnauthorized: true }
         : config.ssl === 'require'     ? { rejectUnauthorized: false }
         : undefined,
      max: 5,
      connectionTimeoutMillis: 10_000,
    });
  }

  escapeIdent(s: string): string {
    return '"' + s.replace(/"/g, '') + '"';
  }

  rowLimitClause(_n: number): string {
    return '';
  }

  async ping(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  async query(sql: string, params?: unknown[], schema?: string): Promise<QueryResult> {
    const client = await this.pool.connect();
    let searchPathSet = false;
    try {
      if (schema) {
        await client.query(`SET search_path TO ${this.escapeIdent(schema)}`);
        searchPathSet = true;
      }

      // Naive ?→$N rewrite: assumes machine-generated SQL when params is non-empty.
      // User-authored SQL must be passed without params (the rewrite is skipped then).
      let pgSql = sql;
      if (params?.length) {
        let n = 0;
        pgSql = sql.replace(/\?/g, () => `$${++n}`);
      }
      const result = await client.query({ text: pgSql, values: params?.length ? params : undefined });

      // Non-SELECT (INSERT, UPDATE, DELETE, DDL, etc.)
      if (!result.fields || result.fields.length === 0) {
        return {
          rows: [],
          columnMeta: [],
          affectedRows: result.rowCount ?? 0,
          insertId: null,
        };
      }

      const columnMeta: ColumnMeta[] = result.fields.map(f => ({
        name: f.name,
        orgName: f.name,
        table: '',
        orgTable: '',
        pk: false,
        unique: false,
        notNull: false,
        mysqlType: 0,
      }));

      const columns = result.fields.map(f => f.name);
      const serializedRows = (result.rows as Record<string, unknown>[]).map(row => {
        const out: Record<string, unknown> = {};
        for (const col of columns) {
          const val = row[col];
          if (val === null || val === undefined) {
            out[col] = null;
          } else if (Buffer.isBuffer(val)) {
            out[col] = val.toString('hex');
          } else if (val instanceof Date) {
            out[col] = val.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
          } else {
            out[col] = val;
          }
        }
        return out;
      });

      return { rows: serializedRows, columnMeta };
    } finally {
      // pg.Pool reuses clients without resetting session state, so search_path
      // would leak to the next caller on this same client.
      if (searchPathSet) {
        try { await client.query('SET search_path TO DEFAULT'); } catch { /* fall through to release */ }
      }
      client.release();
    }
  }

  async getSchemas(): Promise<string[]> {
    const result = await this.pool.query<{ name: string }>(
      `SELECT schema_name AS name
       FROM information_schema.schemata
       WHERE schema_name NOT IN ('information_schema', 'pg_catalog')
         AND schema_name NOT LIKE 'pg_toast%'
       ORDER BY schema_name`,
    );
    return result.rows.map(r => r.name);
  }

  async getSchema(schema: string): Promise<SchemaInfo> {
    const client = await this.pool.connect();
    try {
      // pg clients are single-connection — queries must be sequential, not concurrent
      const tablesRes = await client.query<{ name: string; row_count: string }>(
        `SELECT t.table_name AS name,
                COALESCE(s.n_live_tup, 0)::text AS row_count
         FROM information_schema.tables t
         LEFT JOIN pg_stat_user_tables s
           ON s.schemaname = t.table_schema AND s.relname = t.table_name
         WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
         ORDER BY t.table_name`,
        [schema],
      );
      const columnsRes = await client.query<{
        tbl: string; col: string; col_type: string; data_type: string;
        is_pk: string; nullable: string; col_default: string | null; extra: string;
      }>(
        `SELECT c.table_name AS tbl,
                c.column_name AS col,
                c.udt_name AS col_type,
                c.data_type AS data_type,
                CASE WHEN pk.column_name IS NOT NULL THEN '1' ELSE '0' END AS is_pk,
                CASE WHEN c.is_nullable = 'YES' THEN '1' ELSE '0' END AS nullable,
                c.column_default AS col_default,
                CASE WHEN c.column_default LIKE 'nextval(%' OR c.is_identity = 'YES'
                     THEN 'auto_increment' ELSE '' END AS extra
         FROM information_schema.columns c
         LEFT JOIN (
           SELECT kcu.table_name, kcu.column_name, kcu.table_schema
           FROM information_schema.key_column_usage kcu
           JOIN information_schema.table_constraints tc
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
             AND tc.table_name = kcu.table_name
             AND tc.constraint_type = 'PRIMARY KEY'
           WHERE kcu.table_schema = $1
         ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
         WHERE c.table_schema = $1
         ORDER BY c.table_name, c.ordinal_position`,
        [schema],
      );
      const viewsRes = await client.query<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.views
         WHERE table_schema = $1 ORDER BY table_name`,
        [schema],
      );
      const procsRes = await client.query<{ name: string }>(
        `SELECT routine_name AS name FROM information_schema.routines
         WHERE routine_schema = $1 AND routine_type IN ('FUNCTION', 'PROCEDURE')
         ORDER BY routine_name`,
        [schema],
      );
      const triggersRes = await client.query<{ name: string }>(
        `SELECT DISTINCT trigger_name AS name FROM information_schema.triggers
         WHERE event_object_schema = $1 ORDER BY trigger_name`,
        [schema],
      );

      const colsByTable = new Map<string, ColumnInfo[]>();
      for (const col of columnsRes.rows) {
        const tname = col.tbl;
        if (!colsByTable.has(tname)) colsByTable.set(tname, []);
        colsByTable.get(tname)!.push({
          name: col.col,
          type: col.col_type,
          dataType: (col.data_type ?? '').toLowerCase(),
          pk: col.is_pk === '1',
          nullable: col.nullable === '1',
          default: col.col_default ?? null,
          autoIncrement: col.extra.includes('auto_increment'),
          comment: '',
        });
      }

      return {
        tables: tablesRes.rows.map(t => ({
          name: t.name,
          rows: Number(t.row_count),
          comment: '',
          columns: colsByTable.get(t.name) ?? [],
        })),
        views: viewsRes.rows.map(v => v.name),
        procedures: procsRes.rows.map(p => p.name),
        triggers: triggersRes.rows.map(t => t.name),
      };
    } finally {
      client.release();
    }
  }

  async getTable(schema: string, table: string): Promise<TableInfo | null> {
    const client = await this.pool.connect();
    try {
      const tableRes = await client.query<{ name: string; row_count: string }>(
        `SELECT t.table_name AS name,
                COALESCE(s.n_live_tup, 0)::text AS row_count
         FROM information_schema.tables t
         LEFT JOIN pg_stat_user_tables s
           ON s.schemaname = t.table_schema AND s.relname = t.table_name
         WHERE t.table_schema = $1 AND t.table_name = $2 AND t.table_type = 'BASE TABLE'`,
        [schema, table],
      );
      if (tableRes.rows.length === 0) return null;

      const colsRes = await client.query<{
        col: string; col_type: string; data_type: string;
        is_pk: string; nullable: string; col_default: string | null; extra: string;
      }>(
        `SELECT c.column_name AS col,
                c.udt_name AS col_type,
                c.data_type AS data_type,
                CASE WHEN pk.column_name IS NOT NULL THEN '1' ELSE '0' END AS is_pk,
                CASE WHEN c.is_nullable = 'YES' THEN '1' ELSE '0' END AS nullable,
                c.column_default AS col_default,
                CASE WHEN c.column_default LIKE 'nextval(%' OR c.is_identity = 'YES'
                     THEN 'auto_increment' ELSE '' END AS extra
         FROM information_schema.columns c
         LEFT JOIN (
           SELECT kcu.table_name, kcu.column_name, kcu.table_schema
           FROM information_schema.key_column_usage kcu
           JOIN information_schema.table_constraints tc
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
             AND tc.table_name = kcu.table_name
             AND tc.constraint_type = 'PRIMARY KEY'
           WHERE kcu.table_schema = $1 AND kcu.table_name = $2
         ) pk ON pk.column_name = c.column_name
         WHERE c.table_schema = $1 AND c.table_name = $2
         ORDER BY c.ordinal_position`,
        [schema, table],
      );

      const cols: ColumnInfo[] = colsRes.rows.map(r => ({
        name: r.col,
        type: r.col_type,
        dataType: (r.data_type ?? '').toLowerCase(),
        pk: r.is_pk === '1',
        nullable: r.nullable === '1',
        default: r.col_default ?? null,
        autoIncrement: r.extra.includes('auto_increment'),
        comment: '',
      }));

      return {
        name: tableRes.rows[0].name,
        rows: Number(tableRes.rows[0].row_count),
        comment: '',
        columns: cols,
      };
    } finally {
      client.release();
    }
  }

  async getTableDdl(schema: string, table: string, type: 'table' | 'view' | 'procedure' | 'trigger'): Promise<string> {
    const qualified = `${this.escapeIdent(schema)}.${this.escapeIdent(table)}`;

    if (type === 'view') {
      const result = await this.pool.query<{ view_definition: string }>(
        `SELECT view_definition FROM information_schema.views
         WHERE table_schema = $1 AND table_name = $2`,
        [schema, table],
      );
      if (result.rows.length === 0) throw new Error(`No DDL returned for ${qualified}.`);
      return `CREATE OR REPLACE VIEW ${qualified} AS\n${result.rows[0].view_definition}`;
    }

    if (type === 'procedure') {
      const result = await this.pool.query<{ def: string }>(
        `SELECT pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = $2
         LIMIT 1`,
        [schema, table],
      );
      if (result.rows.length === 0) throw new Error(`No DDL returned for ${qualified}.`);
      return result.rows[0].def;
    }

    if (type === 'trigger') {
      const result = await this.pool.query<{ def: string }>(
        `SELECT pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND t.tgname = $2`,
        [schema, table],
      );
      if (result.rows.length === 0) throw new Error(`No DDL returned for ${qualified}.`);
      return result.rows[0].def;
    }

    // type === 'table' — reconstruct DDL from catalog tables
    const client = await this.pool.connect();
    try {
      const colsRes = await client.query<{
        column_name: string; data_type: string; udt_name: string;
        character_maximum_length: string | null; numeric_precision: string | null;
        numeric_scale: string | null; is_nullable: string;
        column_default: string | null; is_identity: string;
      }>(
        `SELECT column_name, data_type, udt_name,
                character_maximum_length::text, numeric_precision::text, numeric_scale::text,
                is_nullable, column_default, is_identity
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table],
      );
      const pkRes = await client.query<{ column_name: string }>(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema = tc.table_schema
           AND kcu.table_name = tc.table_name
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY kcu.ordinal_position`,
        [schema, table],
      );
      const idxRes = await client.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2`,
        [schema, table],
      );

      if (colsRes.rows.length === 0) throw new Error(`No DDL returned for ${qualified}.`);

      const pkCols = new Set(pkRes.rows.map(r => r.column_name));

      const colDefs = colsRes.rows.map(r => {
        const isSerial =
          r.is_identity === 'YES' ||
          (r.column_default?.startsWith('nextval(') ?? false);

        let typeDef: string;
        if (isSerial) {
          typeDef = r.udt_name === 'int8' ? 'bigserial'
                  : r.udt_name === 'int2' ? 'smallserial'
                  : 'serial';
        } else if (r.data_type === 'character varying') {
          typeDef = r.character_maximum_length ? `varchar(${r.character_maximum_length})` : 'varchar';
        } else if (r.data_type === 'character') {
          typeDef = r.character_maximum_length ? `char(${r.character_maximum_length})` : 'char';
        } else if (r.data_type === 'numeric' || r.data_type === 'decimal') {
          typeDef = r.numeric_precision && r.numeric_scale !== null
            ? `numeric(${r.numeric_precision},${r.numeric_scale})`
            : 'numeric';
        } else {
          typeDef = r.udt_name ?? r.data_type;
        }

        let def = `  ${this.escapeIdent(r.column_name)} ${typeDef}`;
        if (r.is_nullable === 'NO' && !isSerial) def += ' NOT NULL';
        if (r.column_default && !isSerial) def += ` DEFAULT ${r.column_default}`;
        return def;
      });

      if (pkCols.size > 0) {
        colDefs.push(`  PRIMARY KEY (${[...pkCols].map(c => this.escapeIdent(c)).join(', ')})`);
      }

      let ddl = `CREATE TABLE ${qualified} (\n${colDefs.join(',\n')}\n)`;

      for (const idx of idxRes.rows) {
        if (!idx.indexname.endsWith('_pkey')) {
          ddl += `;\n${idx.indexdef}`;
        }
      }

      return ddl;
    } finally {
      client.release();
    }
  }
}

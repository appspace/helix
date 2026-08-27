import pg from 'pg';
import { DriverError } from './interface.js';
import type { DbDriver, ConnectionConfig, QueryResult, ColumnMeta, ColumnInfo, ForeignKeyInfo, IndexInfo, SchemaInfo, TableInfo } from './interface.js';

// Return DATE / TIME / TIMESTAMP / TIMESTAMPTZ / TIMETZ as raw strings rather
// than JS Dates. pg's default parsers route through `new Date(...)`, which
// (a) loses sub-millisecond precision and (b) re-renders the value in whatever
// timezone the consumer happens to call `toISOString()` from — a row written
// as "2026-05-07 10:00:00" comes back skewed by hours in any process whose TZ
// differs from where it was written. Helix is a DB browser; show the literal
// value the server hands us. setTypeParser mutates pg's global registry, but
// pg is only used by this driver in this app.
const PG_DATE = 1082;
const PG_TIME = 1083;
const PG_TIMESTAMP = 1114;
const PG_TIMESTAMPTZ = 1184;
const PG_TIMETZ = 1266;
const identity = (v: string) => v;
for (const oid of [PG_DATE, PG_TIME, PG_TIMESTAMP, PG_TIMESTAMPTZ, PG_TIMETZ]) {
  pg.types.setTypeParser(oid, identity);
}

function classifyPgError(err: unknown): DriverError {
  const message = err instanceof Error ? err.message : String(err);
  if (err && typeof (err as Record<string, unknown>).code === 'string') {
    const code = (err as Record<string, unknown>).code as string;
    // 08xxx=connection, 53xxx=insufficient resources, 57xxx=operator intervention
    if (code.startsWith('08') || code.startsWith('53') || code.startsWith('57')) {
      return new DriverError(message, 'transient', { cause: err });
    }
    // 42xxx=syntax/access errors, 28xxx=invalid authorization
    if (code.startsWith('42') || code.startsWith('28')) {
      return new DriverError(message, 'client', { cause: err });
    }
  }
  return new DriverError(message, 'server', { cause: err });
}

function buildPgPoolConfig(config: ConnectionConfig): pg.PoolConfig {
  return {
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
    // OS-level TCP keepalive so dead sockets after macOS sleep are surfaced
    // in seconds rather than the kernel's default ~2 hours. See #145.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

function buildPgResult(result: pg.QueryResult): QueryResult {
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
}

// pg_index.indkey is an ordered vector of column numbers, so unnesting it WITH
// ORDINALITY is what preserves index order — information_schema has no
// equivalent view for indexes. The int2[] cast is explicit because unnest has
// no int2vector overload of its own. attnum 0 marks an expression part of a
// functional index; those join to no pg_attribute row and come back NULL.
// Trailing INCLUDE columns (PG 11+) are listed too: they are part of the index
// even though they can't drive a lookup, and their position after the key
// columns already marks them as non-leading.
const PG_INDEX_SQL = `
  SELECT c.relname AS tbl,
         i.relname AS idx,
         ix.indisunique AS is_unique,
         am.amname AS idx_type,
         a.attname AS col
  FROM pg_index ix
  JOIN pg_class c ON c.oid = ix.indrelid
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_am am ON am.oid = i.relam
  CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
  LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
  WHERE n.nspname = $1`;

interface PgIndexRow {
  tbl: string;
  idx: string;
  is_unique: boolean;
  idx_type: string;
  col: string | null;
}

/** Fold the one-row-per-(index, column) result of `PG_INDEX_SQL` into one `IndexInfo` per index, keyed by table. */
function groupPgIndexes(rows: PgIndexRow[]): Map<string, IndexInfo[]> {
  const byTable = new Map<string, IndexInfo[]>();
  for (const row of rows) {
    if (!byTable.has(row.tbl)) byTable.set(row.tbl, []);
    const list = byTable.get(row.tbl)!;
    let idx = list.find(i => i.name === row.idx);
    if (!idx) {
      idx = { name: row.idx, unique: row.is_unique, columns: [], type: row.idx_type ?? '' };
      list.push(idx);
    }
    idx.columns.push(row.col ?? '(expression)');
  }
  return byTable;
}

// conkey and confkey are parallel attnum vectors — the nth referencing column
// maps to the nth referenced one — so they must be unnested together to keep
// composite keys aligned. information_schema.key_column_usage can express the
// same thing but needs three joins to recover the referenced side.
const PG_FK_SQL = `
  SELECT c.relname AS tbl,
         con.conname AS name,
         a.attname AS col,
         rn.nspname AS ref_schema,
         rc.relname AS ref_tbl,
         ra.attname AS ref_col
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class rc ON rc.oid = con.confrelid
  JOIN pg_namespace rn ON rn.oid = rc.relnamespace
  CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(att, ref_att, ord)
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.att
  JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.ref_att
  WHERE con.contype = 'f' AND n.nspname = $1`;

interface PgForeignKeyRow {
  tbl: string;
  name: string;
  col: string;
  ref_schema: string;
  ref_tbl: string;
  ref_col: string;
}

/** Fold the one-row-per-(constraint, column) result of `PG_FK_SQL` into one `ForeignKeyInfo` per constraint, keyed by table. */
function groupPgForeignKeys(rows: PgForeignKeyRow[]): Map<string, ForeignKeyInfo[]> {
  const byTable = new Map<string, ForeignKeyInfo[]>();
  for (const row of rows) {
    if (!byTable.has(row.tbl)) byTable.set(row.tbl, []);
    const list = byTable.get(row.tbl)!;
    let fk = list.find(f => f.name === row.name);
    if (!fk) {
      fk = {
        name: row.name,
        columns: [],
        referencedSchema: row.ref_schema,
        referencedTable: row.ref_tbl,
        referencedColumns: [],
      };
      list.push(fk);
    }
    fk.columns.push(row.col);
    fk.referencedColumns.push(row.ref_col);
  }
  return byTable;
}

export class PostgresDriver implements DbDriver {
  readonly queryMode = 'sql' as const;
  private pool: pg.Pool;
  private config: ConnectionConfig;
  private recycling: Promise<void> | null = null;

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.pool = new pg.Pool(buildPgPoolConfig(config));
  }

  /** See `MysqlDriver.recyclePool`. pg's `pool.end()` is stricter than mysql2's
   * (waits for every checked-out client to be released), which makes the
   * fire-and-forget on `old.end()` even more important here. */
  recyclePool(): Promise<void> {
    if (this.recycling) return this.recycling;
    const old = this.pool;
    this.pool = new pg.Pool(buildPgPoolConfig(this.config));
    void old.end().catch(() => { /* dead clients — nothing to do */ });
    this.recycling = this.pool
      .connect()
      .then(c => c.release())
      .catch(() => { /* will surface on the user's next query */ })
      .finally(() => { this.recycling = null; });
    return this.recycling;
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
    try {
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
        // node-pg's simple query protocol returns an array of results when the SQL
        // contains multiple statements. `query()` keeps the legacy single-result
        // contract — `queryAll` is the multi-statement entry point — so collapse
        // an unexpected array down to its last element.
        const single = Array.isArray(result) ? (result as pg.QueryResult[])[result.length - 1] : result;
        return buildPgResult(single);
      } finally {
        // pg.Pool reuses clients without resetting session state, so search_path
        // would leak to the next caller on this same client.
        if (searchPathSet) {
          try { await client.query('SET search_path TO DEFAULT'); } catch { /* fall through to release */ }
        }
        client.release();
      }
    } catch (err) {
      if (err instanceof DriverError) throw err;
      throw classifyPgError(err);
    }
  }

  async queryAll(sql: string, schema?: string): Promise<QueryResult[]> {
    try {
      const client = await this.pool.connect();
      let searchPathSet = false;
      try {
        if (schema) {
          await client.query(`SET search_path TO ${this.escapeIdent(schema)}`);
          searchPathSet = true;
        }
        // Always go through the simple query protocol (no values) so multi-statement
        // SQL fans out to one result per statement.
        const raw = await client.query(sql);
        const results = Array.isArray(raw) ? (raw as pg.QueryResult[]) : [raw];
        return results.map(buildPgResult);
      } finally {
        if (searchPathSet) {
          try { await client.query('SET search_path TO DEFAULT'); } catch { /* fall through to release */ }
        }
        client.release();
      }
    } catch (err) {
      if (err instanceof DriverError) throw err;
      throw classifyPgError(err);
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
      const indexesRes = await client.query<PgIndexRow>(
        `${PG_INDEX_SQL}
         ORDER BY c.relname, i.relname, k.ord`,
        [schema],
      );
      const fksRes = await client.query<PgForeignKeyRow>(
        `${PG_FK_SQL}
         ORDER BY c.relname, con.conname, k.ord`,
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

      const indexesByTable = groupPgIndexes(indexesRes.rows);
      const fksByTable = groupPgForeignKeys(fksRes.rows);

      return {
        tables: tablesRes.rows.map(t => ({
          name: t.name,
          rows: Number(t.row_count),
          comment: '',
          columns: colsByTable.get(t.name) ?? [],
          indexes: indexesByTable.get(t.name) ?? [],
          foreignKeys: fksByTable.get(t.name) ?? [],
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

      const indexesRes = await client.query<PgIndexRow>(
        `${PG_INDEX_SQL} AND c.relname = $2
         ORDER BY i.relname, k.ord`,
        [schema, table],
      );

      const fksRes = await client.query<PgForeignKeyRow>(
        `${PG_FK_SQL} AND c.relname = $2
         ORDER BY con.conname, k.ord`,
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
        indexes: groupPgIndexes(indexesRes.rows).get(table) ?? [],
        foreignKeys: groupPgForeignKeys(fksRes.rows).get(table) ?? [],
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

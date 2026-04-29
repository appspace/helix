import { MongoClient, ObjectId } from 'mongodb';
import type { Db, Document } from 'mongodb';
import type {
  DbDriver,
  ConnectionConfig,
  QueryResult,
  ColumnMeta,
  ColumnInfo,
  SchemaInfo,
  TableInfo,
  CollectionInfo,
} from './interface.js';

/**
 * MQL request shape carried over the wire as a JSON string in `query()`'s `sql` arg.
 * Routes serialize a request object into JSON; the driver parses and dispatches by `operation`.
 */
interface MqlRequest {
  collection: string;
  operation:
    | 'find'
    | 'findOne'
    | 'aggregate'
    | 'count'
    | 'insertOne'
    | 'updateOne'
    | 'deleteOne';
  filter?: Document;
  pipeline?: Document[];
  projection?: Document;
  sort?: Document;
  limit?: number;
  skip?: number;
  document?: Document;
  update?: Document;
  id?: unknown;
}

const SYSTEM_DBS = new Set(['admin', 'local', 'config']);

function buildMongoUri(config: ConnectionConfig): string {
  if (config.connectionString) return config.connectionString;
  const user = config.user ?? '';
  const password = config.password ?? '';
  const auth =
    user || password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
      : '';
  return `mongodb://${auth}${config.host}:${config.port}/`;
}

function serializeValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (val instanceof ObjectId) return val.toHexString();
  if (val instanceof Date) {
    // toISOString is always UTC, so the rendered string is timezone-stable
    // regardless of process TZ. We deliberately drop the trailing "Z" / millis
    // to match the SQL drivers' DATETIME-style output.
    return val.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  }
  if (Buffer.isBuffer(val)) return val.toString('hex');
  if (Array.isArray(val)) return val.map(serializeValue);
  if (typeof val === 'bigint') return val.toString();
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return val;
}

function serializeDocument(doc: Document): Record<string, unknown> {
  return serializeValue(doc) as Record<string, unknown>;
}

function inferDataType(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (val instanceof ObjectId) return 'objectId';
  if (val instanceof Date) return 'date';
  if (Buffer.isBuffer(val)) return 'binData';
  if (Array.isArray(val)) return 'array';
  const t = typeof val;
  if (t === 'string') return 'string';
  if (t === 'number') return Number.isInteger(val) ? 'int' : 'double';
  if (t === 'boolean') return 'bool';
  if (t === 'bigint') return 'long';
  if (t === 'object') return 'object';
  return t;
}

// TODO(#107 follow-up): drive _id coercion from column metadata once routes
// pass it. Today we treat any 24-hex string as an ObjectId, which has
// false-positive risk for app-generated ids that happen to match the shape;
// callers compensate by retrying with the raw string when an ObjectId match
// affects 0 rows (see coerceIdFilterFallback).
function coerceIdFilter(id: unknown): Document {
  if (typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)) {
    return { _id: new ObjectId(id) };
  }
  return { _id: id } as Document;
}

/** True when coerceIdFilter promoted a string id to an ObjectId. */
function idWasCoercedToObjectId(id: unknown): boolean {
  return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
}

function parseRequest(sql: string): MqlRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sql);
  } catch {
    throw new Error('MongoDB driver expects a JSON-encoded MQL request.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('MongoDB driver expects a JSON-encoded MQL request.');
  }
  const req = parsed as MqlRequest;
  if (!req.collection || typeof req.collection !== 'string') {
    throw new Error('MQL request requires a "collection" field.');
  }
  if (!req.operation) {
    throw new Error('MQL request requires an "operation" field.');
  }
  return req;
}

export class MongoDBDriver implements DbDriver {
  readonly queryMode = 'mql' as const;
  private client: MongoClient;
  private defaultDb: string | undefined;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(config: ConnectionConfig) {
    this.client = new MongoClient(buildMongoUri(config), {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
      maxPoolSize: 5,
    });
    this.defaultDb = config.database || undefined;
  }

  escapeIdent(s: string): string {
    return s;
  }

  rowLimitClause(_n: number): string {
    return '';
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().then(
        () => {
          this.connected = true;
        },
        (err) => {
          this.connectPromise = null;
          throw err;
        },
      );
    }
    await this.connectPromise;
  }

  private db(schema?: string): Db {
    const name = schema || this.defaultDb;
    return name ? this.client.db(name) : this.client.db();
  }

  async ping(): Promise<void> {
    await this.ensureConnected();
    await this.client.db('admin').command({ ping: 1 });
  }

  async end(): Promise<void> {
    if (this.connected || this.connectPromise) {
      try {
        await this.client.close();
      } finally {
        this.connected = false;
        this.connectPromise = null;
      }
    }
  }

  async query(sql: string, _params?: unknown[], schema?: string): Promise<QueryResult> {
    await this.ensureConnected();
    const req = parseRequest(sql);
    const db = this.db(schema);
    const coll = db.collection(req.collection);

    switch (req.operation) {
      case 'find': {
        let cursor = coll.find(req.filter ?? {});
        if (req.projection) cursor = cursor.project(req.projection) as typeof cursor;
        if (req.sort) cursor = cursor.sort(req.sort);
        if (typeof req.skip === 'number') cursor = cursor.skip(req.skip);
        if (typeof req.limit === 'number') cursor = cursor.limit(req.limit);
        const docs = await cursor.toArray();
        return this.toQueryResult(docs);
      }
      case 'findOne': {
        const doc = await coll.findOne(req.filter ?? {}, {
          projection: req.projection,
          sort: req.sort as Document | undefined,
        });
        return this.toQueryResult(doc ? [doc] : []);
      }
      case 'aggregate': {
        const docs = await coll.aggregate(req.pipeline ?? []).toArray();
        return this.toQueryResult(docs);
      }
      case 'count': {
        const n = await coll.countDocuments(req.filter ?? {});
        return {
          rows: [{ count: n }],
          columnMeta: [
            {
              name: 'count', orgName: 'count', table: req.collection, orgTable: req.collection,
              pk: false, unique: false, notNull: true, mysqlType: 0,
            },
          ],
        };
      }
      case 'insertOne': {
        if (!req.document) throw new Error('insertOne requires a "document" field.');
        const result = await coll.insertOne(req.document);
        return {
          rows: [],
          columnMeta: [],
          affectedRows: result.acknowledged ? 1 : 0,
          insertId: null,
        };
      }
      case 'updateOne': {
        if (!req.update) throw new Error('updateOne requires an "update" field.');
        const useId = req.id !== undefined;
        const filter = useId ? coerceIdFilter(req.id) : (req.filter ?? {});
        let result = await coll.updateOne(filter, req.update);
        // Graceful fallback: if we promoted a 24-hex string to ObjectId and
        // matched nothing, retry with the raw string id.
        if (useId && result.matchedCount === 0 && idWasCoercedToObjectId(req.id)) {
          result = await coll.updateOne({ _id: req.id } as Document, req.update);
        }
        // Use matchedCount, not modifiedCount: routes treat affectedRows === 0
        // as "row not found" (404). A no-op update (matched but unchanged) must
        // not be reported as missing.
        return {
          rows: [],
          columnMeta: [],
          affectedRows: result.matchedCount,
          insertId: null,
        };
      }
      case 'deleteOne': {
        const useId = req.id !== undefined;
        const filter = useId ? coerceIdFilter(req.id) : (req.filter ?? {});
        let result = await coll.deleteOne(filter);
        if (useId && result.deletedCount === 0 && idWasCoercedToObjectId(req.id)) {
          result = await coll.deleteOne({ _id: req.id } as Document);
        }
        return {
          rows: [],
          columnMeta: [],
          affectedRows: result.deletedCount,
          insertId: null,
        };
      }
      default: {
        throw new Error(`Unsupported MQL operation: ${String(req.operation)}`);
      }
    }
  }

  private toQueryResult(docs: Document[]): QueryResult {
    const rows = docs.map(serializeDocument);
    const colNames = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) colNames.add(k);
    if (colNames.size === 0) colNames.add('_id');
    const columnMeta: ColumnMeta[] = [...colNames].map((name) => ({
      name,
      orgName: name,
      table: '',
      orgTable: '',
      pk: name === '_id',
      unique: name === '_id',
      notNull: name === '_id',
      mysqlType: 0,
    }));
    return { rows, columnMeta };
  }

  async getSchemas(): Promise<string[]> {
    await this.ensureConnected();
    const result = await this.client.db().admin().listDatabases();
    return result.databases
      .map((d) => d.name)
      .filter((n) => !SYSTEM_DBS.has(n))
      .sort();
  }

  async getSchema(schema: string): Promise<SchemaInfo> {
    await this.ensureConnected();
    const db = this.db(schema);
    const collections = await db.listCollections({}, { nameOnly: false }).toArray();
    const baseCollections = collections.filter((c) => c.type !== 'view');
    const views = collections.filter((c) => c.type === 'view').map((c) => c.name);

    // Best-effort field inference: we sample a single document and mark every
    // column inferred:true. Fields that appear only on later documents are
    // invisible to this pass. Tracked in #118 (union-of-keys sampling).
    const tables: TableInfo[] = await Promise.all(
      baseCollections.map(async (c) => {
        const coll = db.collection(c.name);
        const [sample, count] = await Promise.all([
          coll.findOne({}),
          coll.estimatedDocumentCount().catch(() => 0),
        ]);
        return {
          name: c.name,
          rows: count,
          comment: '',
          columns: this.inferColumns(sample),
        };
      }),
    );

    return {
      tables,
      views,
      procedures: [],
      triggers: [],
    };
  }

  async getTable(schema: string, table: string): Promise<TableInfo | null> {
    await this.ensureConnected();
    const db = this.db(schema);
    const list = await db.listCollections({ name: table }, { nameOnly: false }).toArray();
    if (list.length === 0) return null;
    const coll = db.collection(table);
    const [sample, count] = await Promise.all([
      coll.findOne({}),
      coll.estimatedDocumentCount().catch(() => 0),
    ]);
    return {
      name: table,
      rows: count,
      comment: '',
      columns: this.inferColumns(sample),
    };
  }

  private inferColumns(sample: Document | null): ColumnInfo[] {
    if (!sample) {
      return [
        {
          name: '_id', type: 'objectId', dataType: 'objectId',
          pk: true, nullable: false, default: null, autoIncrement: false,
          comment: '', inferred: true,
        },
      ];
    }
    return Object.keys(sample).map((name) => {
      const dataType = inferDataType(sample[name]);
      return {
        name,
        type: dataType,
        dataType,
        pk: name === '_id',
        nullable: name !== '_id',
        default: null,
        autoIncrement: false,
        comment: '',
        inferred: true,
      };
    });
  }

  async getTableDdl(_schema: string, _table: string, _type: 'table' | 'view' | 'procedure' | 'trigger'): Promise<string> {
    throw new Error('MongoDB driver does not produce SQL DDL; use getCollectionInfo instead.');
  }

  async getCollectionInfo(schema: string, collection: string): Promise<CollectionInfo | null> {
    await this.ensureConnected();
    const db = this.db(schema);
    const list = await db.listCollections({ name: collection }, { nameOnly: false }).toArray();
    if (list.length === 0) return null;
    const opts = list[0]?.options as { validator?: Record<string, unknown> } | undefined;
    const validator = opts?.validator ?? null;
    const indexes = (await db.collection(collection).indexes()) as Record<string, unknown>[];
    return { validator, indexes };
  }
}

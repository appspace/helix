import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCursor = {
  project: vi.fn(),
  sort: vi.fn(),
  skip: vi.fn(),
  limit: vi.fn(),
  toArray: vi.fn(),
};
mockCursor.project.mockReturnValue(mockCursor);
mockCursor.sort.mockReturnValue(mockCursor);
mockCursor.skip.mockReturnValue(mockCursor);
mockCursor.limit.mockReturnValue(mockCursor);

const mockAggCursor = { toArray: vi.fn() };

const mockListCursor = { toArray: vi.fn() };

const mockCollection = {
  find: vi.fn(() => mockCursor),
  findOne: vi.fn(),
  aggregate: vi.fn(() => mockAggCursor),
  countDocuments: vi.fn(),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(),
  estimatedDocumentCount: vi.fn(),
  indexes: vi.fn(),
};

const mockAdmin = {
  listDatabases: vi.fn(),
};

const mockDb = {
  collection: vi.fn(() => mockCollection),
  command: vi.fn(),
  listCollections: vi.fn(() => mockListCursor),
  admin: vi.fn(() => mockAdmin),
};

const mockClient = {
  connect: vi.fn(),
  close: vi.fn(),
  db: vi.fn(() => mockDb),
};

const { ObjectIdCtor } = vi.hoisted(() => {
  const ctor = vi.fn(function (this: { _hex: string }, hex?: string) {
    this._hex = hex ?? 'aaaaaaaaaaaaaaaaaaaaaaaa';
  }) as unknown as {
    new (hex?: string): { _hex: string; toHexString(): string };
    prototype: { toHexString(): string };
  };
  ctor.prototype.toHexString = function (this: { _hex: string }) {
    return this._hex;
  };
  return { ObjectIdCtor: ctor };
});

vi.mock('mongodb', () => ({
  MongoClient: vi.fn(() => mockClient),
  ObjectId: ObjectIdCtor,
}));

import { MongoDBDriver } from './mongodb.js';
import { MongoClient } from 'mongodb';

function makeDriver(database?: string) {
  return new MongoDBDriver({
    host: 'h', port: 27017, user: 'u', password: 'p', database,
    type: 'mongodb',
  });
}

function makeDriverConfig(overrides: Partial<{ user: string; password: string }>) {
  return new MongoDBDriver({
    host: 'h', port: 27017,
    user: overrides.user as string,
    password: overrides.password as string,
    type: 'mongodb',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.connect.mockResolvedValue(undefined);
  mockClient.close.mockResolvedValue(undefined);
  mockClient.db.mockReturnValue(mockDb);
  mockDb.collection.mockReturnValue(mockCollection);
  mockDb.admin.mockReturnValue(mockAdmin);
  mockDb.listCollections.mockReturnValue(mockListCursor);
  mockDb.command.mockResolvedValue({ ok: 1 });
});

describe('MongoDBDriver – static surface', () => {
  it('reports queryMode as mql', () => {
    expect(makeDriver().queryMode).toBe('mql');
  });

  it('escapeIdent is identity (MongoDB needs no quoting)', () => {
    const d = makeDriver();
    expect(d.escapeIdent('users')).toBe('users');
    expect(d.escapeIdent('weird.name`with"quotes')).toBe('weird.name`with"quotes');
  });

  it('rowLimitClause is empty (limits applied via cursor.limit, not SQL)', () => {
    expect(makeDriver().rowLimitClause(10)).toBe('');
  });
});

describe('MongoDBDriver – URI construction', () => {
  function uriFromLastCtor(): string {
    const calls = (MongoClient as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return calls[calls.length - 1][0] as string;
  }

  it('omits credentials when user and password are both empty', () => {
    makeDriverConfig({ user: '', password: '' });
    expect(uriFromLastCtor()).toBe('mongodb://h:27017/');
  });

  it('includes credentials when only the user is set', () => {
    makeDriverConfig({ user: 'alice', password: '' });
    expect(uriFromLastCtor()).toBe('mongodb://alice:@h:27017/');
  });

  it('includes credentials when only the password is set', () => {
    makeDriverConfig({ user: '', password: 'secret' });
    expect(uriFromLastCtor()).toBe('mongodb://:secret@h:27017/');
  });

  it('coerces undefined user/password to empty strings (not the literal "undefined")', () => {
    makeDriverConfig({});
    expect(uriFromLastCtor()).toBe('mongodb://h:27017/');
  });

  it('percent-encodes credentials with reserved characters', () => {
    makeDriverConfig({ user: 'a@b', password: 'p:w/d' });
    expect(uriFromLastCtor()).toBe('mongodb://a%40b:p%3Aw%2Fd@h:27017/');
  });

  it('short-circuits on connectionString — host/port/user/password are ignored', () => {
    const uri = 'mongodb+srv://alice:secret@cluster0.example.net/db';
    new MongoDBDriver({
      host: 'ignored', port: 9999, user: 'ignored-u', password: 'ignored-p',
      type: 'mongodb',
      connectionString: uri,
    });
    expect(uriFromLastCtor()).toBe(uri);
  });
});

describe('MongoDBDriver – connect / disconnect / ping', () => {
  it('ping connects lazily and runs admin command', async () => {
    await makeDriver().ping();
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.db).toHaveBeenCalledWith('admin');
    expect(mockDb.command).toHaveBeenCalledWith({ ping: 1 });
  });

  it('end closes the client when connected', async () => {
    const d = makeDriver();
    await d.ping();
    await d.end();
    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });

  it('end is a no-op when never connected', async () => {
    await makeDriver().end();
    expect(mockClient.close).not.toHaveBeenCalled();
  });

  it('reuses a single in-flight connect promise', async () => {
    const d = makeDriver();
    let resolveConn: (() => void) | null = null;
    mockClient.connect.mockImplementationOnce(
      () => new Promise<void>((res) => { resolveConn = res; }),
    );
    const p1 = d.ping();
    const p2 = d.ping();
    resolveConn!();
    await Promise.all([p1, p2]);
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
  });

  it('clears connect promise so a failed connect can be retried', async () => {
    const d = makeDriver();
    mockClient.connect.mockRejectedValueOnce(new Error('boom'));
    await expect(d.ping()).rejects.toThrow('boom');
    mockClient.connect.mockResolvedValueOnce(undefined);
    await expect(d.ping()).resolves.toBeUndefined();
    expect(mockClient.connect).toHaveBeenCalledTimes(2);
  });
});

describe('MongoDBDriver.query – MQL request parsing', () => {
  it('rejects non-JSON input', async () => {
    await expect(makeDriver().query('SELECT 1')).rejects.toThrow(/JSON-encoded MQL/);
  });

  it('rejects MQL request missing collection', async () => {
    await expect(
      makeDriver().query(JSON.stringify({ operation: 'find' })),
    ).rejects.toThrow(/collection/);
  });

  it('rejects MQL request missing operation', async () => {
    await expect(
      makeDriver().query(JSON.stringify({ collection: 'users' })),
    ).rejects.toThrow(/operation/);
  });

  it('rejects unsupported operation', async () => {
    await expect(
      makeDriver().query(JSON.stringify({ collection: 'users', operation: 'bogus' })),
    ).rejects.toThrow(/Unsupported MQL operation/);
  });
});

describe('MongoDBDriver.query – find', () => {
  it('returns rows with serialized ObjectId and Date', async () => {
    const id = new ObjectIdCtor('507f1f77bcf86cd799439011');
    const when = new Date('2024-01-02T03:04:05.000Z');
    mockCursor.toArray.mockResolvedValueOnce([{ _id: id, name: 'Alice', when }]);
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'users', operation: 'find', filter: { active: true } }),
      [],
      'app',
    );
    expect(mockClient.db).toHaveBeenCalledWith('app');
    expect(mockDb.collection).toHaveBeenCalledWith('users');
    expect(mockCollection.find).toHaveBeenCalledWith({ active: true });
    expect(r.rows).toEqual([
      { _id: '507f1f77bcf86cd799439011', name: 'Alice', when: '2024-01-02 03:04:05' },
    ]);
    expect(r.columnMeta.find((c) => c.name === '_id')?.pk).toBe(true);
  });

  it('serializes Date in UTC regardless of how the Date literal is constructed', async () => {
    // Constructing from an offset-bearing literal (not a "Z" UTC literal) and
    // from millis-since-epoch — both must render identically in UTC.
    const fromOffset = new Date('2024-01-02T03:04:05+05:00'); // 22:04:05Z prev day
    const fromMillis = new Date(Date.UTC(2024, 0, 1, 22, 4, 5));
    mockCursor.toArray.mockResolvedValueOnce([
      { a: fromOffset, b: fromMillis },
    ]);
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'users', operation: 'find' }),
    );
    expect(r.rows[0]).toEqual({
      a: '2024-01-01 22:04:05',
      b: '2024-01-01 22:04:05',
    });
  });

  it('applies projection / sort / skip / limit when provided', async () => {
    mockCursor.toArray.mockResolvedValueOnce([]);
    await makeDriver().query(
      JSON.stringify({
        collection: 'users',
        operation: 'find',
        projection: { name: 1 },
        sort: { name: 1 },
        skip: 5,
        limit: 10,
      }),
    );
    expect(mockCursor.project).toHaveBeenCalledWith({ name: 1 });
    expect(mockCursor.sort).toHaveBeenCalledWith({ name: 1 });
    expect(mockCursor.skip).toHaveBeenCalledWith(5);
    expect(mockCursor.limit).toHaveBeenCalledWith(10);
  });
});

describe('MongoDBDriver.query – BSON scalar serialization', () => {
  it('serializes Decimal128 to its numeric string (positive, negative, zero)', async () => {
    const dec = (s: string) => ({ _bsontype: 'Decimal128', toString: () => s });
    mockCursor.toArray.mockResolvedValueOnce([
      { a: dec('123.45'), b: dec('-987654321.0000001'), c: dec('0') },
    ]);
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'c', operation: 'find' }),
    );
    expect(r.rows[0]).toEqual({ a: '123.45', b: '-987654321.0000001', c: '0' });
  });

  it('serializes Long to its string form (preserves precision past Number.MAX_SAFE_INTEGER)', async () => {
    const long = (s: string) => ({ _bsontype: 'Long', toString: () => s });
    mockCursor.toArray.mockResolvedValueOnce([
      { big: long('9007199254740993'), max: long('9223372036854775807') },
    ]);
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'c', operation: 'find' }),
    );
    expect(r.rows[0]).toEqual({
      big: '9007199254740993',
      max: '9223372036854775807',
    });
  });

  it('serializes Binary subtype 4 (UUID) to canonical UUID string via toUUID()', async () => {
    const uuidStr = '550e8400-e29b-41d4-a716-446655440000';
    const bin = {
      _bsontype: 'Binary',
      sub_type: 4,
      buffer: Buffer.from(uuidStr.replace(/-/g, ''), 'hex'),
      toUUID: () => ({ toString: () => uuidStr }),
    };
    mockCursor.toArray.mockResolvedValueOnce([{ id: bin }]);
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'c', operation: 'find' }),
    );
    expect(r.rows[0]).toEqual({ id: uuidStr });
  });

  it('serializes generic Binary as Binary(subType,base64) and handles empty buffer', async () => {
    const bin = (sub: number, buf: Buffer) => ({
      _bsontype: 'Binary',
      sub_type: sub,
      buffer: buf,
    });
    mockCursor.toArray.mockResolvedValueOnce([
      { hello: bin(0, Buffer.from('hello')), empty: bin(0, Buffer.alloc(0)) },
    ]);
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'c', operation: 'find' }),
    );
    expect(r.rows[0]).toEqual({
      hello: 'Binary(0,aGVsbG8=)',
      empty: 'Binary(0,)',
    });
  });

  it('serializes Timestamp as Timestamp(t, i)', async () => {
    const ts = { _bsontype: 'Timestamp', t: 1234567890, i: 1 };
    mockCursor.toArray.mockResolvedValueOnce([{ ts }]);
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'c', operation: 'find' }),
    );
    expect(r.rows[0]).toEqual({ ts: 'Timestamp(1234567890, 1)' });
  });

  it('serializes BSON scalars nested inside arrays and sub-documents', async () => {
    const dec = { _bsontype: 'Decimal128', toString: () => '1.5' };
    const long = { _bsontype: 'Long', toString: () => '42' };
    mockCursor.toArray.mockResolvedValueOnce([
      { items: [{ price: dec }], stats: { count: long } },
    ]);
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'c', operation: 'find' }),
    );
    expect(r.rows[0]).toEqual({
      items: [{ price: '1.5' }],
      stats: { count: '42' },
    });
  });
});

describe('MongoDBDriver.query – findOne / aggregate / count', () => {
  it('findOne returns at most one row', async () => {
    mockCollection.findOne.mockResolvedValueOnce({ name: 'Bob' });
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'users', operation: 'findOne' }),
    );
    expect(r.rows).toEqual([{ name: 'Bob' }]);
  });

  it('findOne returns no rows when nothing matches', async () => {
    mockCollection.findOne.mockResolvedValueOnce(null);
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'users', operation: 'findOne' }),
    );
    expect(r.rows).toEqual([]);
  });

  it('aggregate runs the supplied pipeline', async () => {
    mockAggCursor.toArray.mockResolvedValueOnce([{ _id: 'A', n: 2 }]);
    const r = await makeDriver().query(
      JSON.stringify({
        collection: 'users',
        operation: 'aggregate',
        pipeline: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
      }),
    );
    expect(mockCollection.aggregate).toHaveBeenCalledWith([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    expect(r.rows).toEqual([{ _id: 'A', n: 2 }]);
  });

  it('count returns a single row with the count', async () => {
    mockCollection.countDocuments.mockResolvedValueOnce(42);
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'users', operation: 'count', filter: { active: true } }),
    );
    expect(mockCollection.countDocuments).toHaveBeenCalledWith({ active: true });
    expect(r.rows).toEqual([{ count: 42 }]);
  });
});

describe('MongoDBDriver.query – writes', () => {
  it('insertOne reports affectedRows = 1 on acknowledged write', async () => {
    mockCollection.insertOne.mockResolvedValueOnce({ acknowledged: true, insertedId: 'x' });
    const r = await makeDriver().query(
      JSON.stringify({ collection: 'users', operation: 'insertOne', document: { name: 'Z' } }),
    );
    expect(mockCollection.insertOne).toHaveBeenCalledWith({ name: 'Z' });
    expect(r.affectedRows).toBe(1);
  });

  it('insertOne errors when document is missing', async () => {
    await expect(
      makeDriver().query(
        JSON.stringify({ collection: 'users', operation: 'insertOne' }),
      ),
    ).rejects.toThrow(/document/);
  });

  it('updateOne uses ObjectId filter when id is a 24-char hex string', async () => {
    mockCollection.updateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });
    await makeDriver().query(
      JSON.stringify({
        collection: 'users',
        operation: 'updateOne',
        id: '507f1f77bcf86cd799439011',
        update: { $set: { name: 'New' } },
      }),
    );
    const call = mockCollection.updateOne.mock.calls[0];
    expect(ObjectIdCtor).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
    expect(call[0]).toHaveProperty('_id');
    expect(call[1]).toEqual({ $set: { name: 'New' } });
  });

  it('updateOne reports affectedRows from matchedCount (no-op update still counts as matched)', async () => {
    mockCollection.updateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 });
    const r = await makeDriver().query(
      JSON.stringify({
        collection: 'users',
        operation: 'updateOne',
        filter: { _id: 1 },
        update: { $set: { name: 'same' } },
      }),
    );
    expect(r.affectedRows).toBe(1);
  });

  it('updateOne retries with raw string id when ObjectId match returns 0 rows', async () => {
    mockCollection.updateOne
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });
    const r = await makeDriver().query(
      JSON.stringify({
        collection: 'users',
        operation: 'updateOne',
        id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        update: { $set: { name: 'X' } },
      }),
    );
    expect(mockCollection.updateOne).toHaveBeenCalledTimes(2);
    expect(mockCollection.updateOne.mock.calls[1][0]).toEqual({
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(r.affectedRows).toBe(1);
  });

  it('updateOne falls back to raw filter when id is not provided', async () => {
    mockCollection.updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
    await makeDriver().query(
      JSON.stringify({
        collection: 'users',
        operation: 'updateOne',
        filter: { name: 'A' },
        update: { $set: { name: 'B' } },
      }),
    );
    expect(mockCollection.updateOne).toHaveBeenCalledWith(
      { name: 'A' },
      { $set: { name: 'B' } },
    );
  });

  it('updateOne errors when update is missing', async () => {
    await expect(
      makeDriver().query(
        JSON.stringify({ collection: 'users', operation: 'updateOne', filter: {} }),
      ),
    ).rejects.toThrow(/update/);
  });

  it('deleteOne reports affectedRows from the driver result', async () => {
    mockCollection.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });
    const r = await makeDriver().query(
      JSON.stringify({
        collection: 'users',
        operation: 'deleteOne',
        id: '507f1f77bcf86cd799439011',
      }),
    );
    expect(r.affectedRows).toBe(1);
  });
});

describe('MongoDBDriver.query – error parity with SQL drivers', () => {
  it('propagates the underlying error when a find operation rejects', async () => {
    mockCursor.toArray.mockRejectedValueOnce(new Error('boom'));
    await expect(
      makeDriver().query(JSON.stringify({ collection: 'users', operation: 'find' })),
    ).rejects.toThrow('boom');
  });

  it('propagates the underlying error when connect fails', async () => {
    mockClient.connect.mockRejectedValueOnce(new Error('no host'));
    await expect(
      makeDriver().query(JSON.stringify({ collection: 'users', operation: 'find' })),
    ).rejects.toThrow('no host');
  });

  it('propagates the underlying error when insertOne rejects, then end() still closes the client', async () => {
    mockCollection.insertOne.mockRejectedValueOnce(new Error('write fail'));
    const d = makeDriver();
    await expect(
      d.query(JSON.stringify({ collection: 'users', operation: 'insertOne', document: {} })),
    ).rejects.toThrow('write fail');
    await d.end();
    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });
});

describe('MongoDBDriver – getSchemas', () => {
  it('lists databases excluding admin / local / config', async () => {
    mockAdmin.listDatabases.mockResolvedValueOnce({
      databases: [
        { name: 'admin' },
        { name: 'local' },
        { name: 'config' },
        { name: 'shop' },
        { name: 'analytics' },
      ],
    });
    const names = await makeDriver().getSchemas();
    expect(names).toEqual(['analytics', 'shop']);
  });
});

describe('MongoDBDriver – getSchema (field inference)', () => {
  it('samples one document per collection and marks columns as inferred', async () => {
    mockListCursor.toArray.mockResolvedValueOnce([
      { name: 'users', type: 'collection' },
      { name: 'orders_v', type: 'view' },
    ]);

    const usersColl = {
      findOne: vi.fn().mockResolvedValueOnce({
        _id: new ObjectIdCtor('aaaaaaaaaaaaaaaaaaaaaaaa'),
        name: 'Ann',
        age: 30,
        joined: new Date('2024-01-01T00:00:00.000Z'),
      }),
      estimatedDocumentCount: vi.fn().mockResolvedValueOnce(7),
    };
    mockDb.collection.mockReturnValueOnce(usersColl as unknown as typeof mockCollection);

    const schema = await makeDriver().getSchema('shop');
    expect(schema.views).toEqual(['orders_v']);
    expect(schema.tables).toHaveLength(1);
    const t = schema.tables[0];
    expect(t.name).toBe('users');
    expect(t.rows).toBe(7);
    expect(t.columns.every((c) => c.inferred === true)).toBe(true);
    const cmap = Object.fromEntries(t.columns.map((c) => [c.name, c]));
    expect(cmap['_id'].pk).toBe(true);
    expect(cmap['_id'].dataType).toBe('objectId');
    expect(cmap['name'].dataType).toBe('string');
    expect(cmap['age'].dataType).toBe('int');
    expect(cmap['joined'].dataType).toBe('date');
  });

  it('emits a placeholder _id column when a collection is empty', async () => {
    mockListCursor.toArray.mockResolvedValueOnce([{ name: 'empty', type: 'collection' }]);
    const emptyColl = {
      findOne: vi.fn().mockResolvedValueOnce(null),
      estimatedDocumentCount: vi.fn().mockResolvedValueOnce(0),
    };
    mockDb.collection.mockReturnValueOnce(emptyColl as unknown as typeof mockCollection);
    const schema = await makeDriver().getSchema('shop');
    expect(schema.tables[0].columns).toEqual([
      expect.objectContaining({ name: '_id', pk: true, inferred: true }),
    ]);
  });
});

describe('MongoDBDriver – getTable', () => {
  it('returns null when the collection does not exist', async () => {
    mockListCursor.toArray.mockResolvedValueOnce([]);
    const r = await makeDriver().getTable('shop', 'ghost');
    expect(r).toBeNull();
  });

  it('returns inferred columns when the collection exists', async () => {
    mockListCursor.toArray.mockResolvedValueOnce([{ name: 'users', type: 'collection' }]);
    mockCollection.findOne.mockResolvedValueOnce({ name: 'X' });
    mockCollection.estimatedDocumentCount.mockResolvedValueOnce(3);
    const r = await makeDriver().getTable('shop', 'users');
    expect(r?.name).toBe('users');
    expect(r?.columns.find((c) => c.name === 'name')?.inferred).toBe(true);
  });
});

describe('MongoDBDriver – getCollectionInfo', () => {
  it('returns the validator and indexes', async () => {
    mockListCursor.toArray.mockResolvedValueOnce([
      { name: 'users', type: 'collection', options: { validator: { $jsonSchema: { bsonType: 'object' } } } },
    ]);
    mockCollection.indexes.mockResolvedValueOnce([
      { v: 2, key: { _id: 1 }, name: '_id_' },
      { v: 2, key: { email: 1 }, name: 'email_1', unique: true },
    ]);
    const r = await makeDriver().getCollectionInfo('shop', 'users');
    expect(r?.validator).toEqual({ $jsonSchema: { bsonType: 'object' } });
    expect(r?.indexes).toHaveLength(2);
  });

  it('returns null validator when none is set', async () => {
    mockListCursor.toArray.mockResolvedValueOnce([{ name: 'users', type: 'collection', options: {} }]);
    mockCollection.indexes.mockResolvedValueOnce([]);
    const r = await makeDriver().getCollectionInfo('shop', 'users');
    expect(r?.validator).toBeNull();
    expect(r?.indexes).toEqual([]);
  });

  it('returns null when the collection does not exist (mirrors getTable)', async () => {
    mockListCursor.toArray.mockResolvedValueOnce([]);
    const r = await makeDriver().getCollectionInfo('shop', 'ghost');
    expect(r).toBeNull();
    // Must not query indexes on a missing collection (avoids NamespaceNotFound).
    expect(mockCollection.indexes).not.toHaveBeenCalled();
  });
});

describe('MongoDBDriver – getTableDdl', () => {
  it('throws — DDL is not applicable to document stores', async () => {
    await expect(
      makeDriver().getTableDdl('shop', 'users', 'table'),
    ).rejects.toThrow(/getCollectionInfo/);
  });
});

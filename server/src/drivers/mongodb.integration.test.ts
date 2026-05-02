import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoDBDriver } from './mongodb.js';

const MONGO_CONFIG = {
  host: process.env['MONGO_HOST'] ?? 'localhost',
  port: Number(process.env['MONGO_PORT'] ?? 27018),
  type: 'mongodb' as const,
};

let driver: MongoDBDriver;
let raw: MongoClient;

beforeAll(async () => {
  driver = new MongoDBDriver(MONGO_CONFIG);
  raw = new MongoClient(`mongodb://${MONGO_CONFIG.host}:${MONGO_CONFIG.port}/`);
  await raw.connect();
});

afterAll(async () => {
  await raw.close();
  await driver.end();
});

beforeEach(async () => {
  await raw.db('helix_test').collection('users').deleteMany({});
});

afterEach(async () => {
  await raw.db('helix_test').collection('users').deleteMany({});
});

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

describe('MongoDBDriver – ping', () => {
  it('resolves without error when connected', async () => {
    await expect(driver.ping()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getSchemas
// ---------------------------------------------------------------------------

describe('MongoDBDriver – getSchemas', () => {
  it('returns user databases and excludes system databases', async () => {
    const schemas = await driver.getSchemas();
    expect(schemas).toContain('helix_test');
    expect(schemas).not.toContain('admin');
    expect(schemas).not.toContain('local');
    expect(schemas).not.toContain('config');
  });
});

// ---------------------------------------------------------------------------
// getSchema
// ---------------------------------------------------------------------------

describe('MongoDBDriver – getSchema', () => {
  it('returns collections with inferred columns from a sample document', async () => {
    await raw.db('helix_test').collection('users').insertOne({ name: 'Alice', age: 30 });
    const info = await driver.getSchema('helix_test');
    const users = info.tables.find(t => t.name === 'users');
    expect(users).toBeDefined();
    const names = users!.columns.map(c => c.name);
    expect(names).toContain('_id');
    expect(names).toContain('name');
    expect(names).toContain('age');
  });

  it('returns _id-only columns for an empty collection', async () => {
    const info = await driver.getSchema('helix_test');
    const users = info.tables.find(t => t.name === 'users');
    expect(users).toBeDefined();
    expect(users!.columns.map(c => c.name)).toEqual(['_id']);
  });

  it('marks _id column as pk', async () => {
    await raw.db('helix_test').collection('users').insertOne({ name: 'Bob' });
    const info = await driver.getSchema('helix_test');
    const idCol = info.tables.find(t => t.name === 'users')!.columns.find(c => c.name === '_id');
    expect(idCol!.pk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// query – find
// ---------------------------------------------------------------------------

describe('MongoDBDriver – query (find)', () => {
  it('returns empty rows when collection is empty', async () => {
    const result = await driver.query(
      JSON.stringify({ collection: 'users', operation: 'find' }),
      [],
      'helix_test',
    );
    expect(result.rows).toEqual([]);
  });

  it('returns inserted documents', async () => {
    await raw.db('helix_test').collection('users').insertMany([
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);
    const result = await driver.query(
      JSON.stringify({ collection: 'users', operation: 'find', sort: { name: 1 } }),
      [],
      'helix_test',
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ name: 'Alice', age: 30 });
    expect(result.rows[1]).toMatchObject({ name: 'Bob', age: 25 });
  });

  it('serializes ObjectId _id as a hex string', async () => {
    await raw.db('helix_test').collection('users').insertOne({ name: 'Carol' });
    const result = await driver.query(
      JSON.stringify({ collection: 'users', operation: 'find' }),
      [],
      'helix_test',
    );
    expect(typeof result.rows[0]!['_id']).toBe('string');
    expect(result.rows[0]!['_id']).toMatch(/^[a-f0-9]{24}$/);
  });

  it('applies limit', async () => {
    await raw.db('helix_test').collection('users').insertMany([
      { name: 'A' }, { name: 'B' }, { name: 'C' },
    ]);
    const result = await driver.query(
      JSON.stringify({ collection: 'users', operation: 'find', limit: 2 }),
      [],
      'helix_test',
    );
    expect(result.rows).toHaveLength(2);
  });

  it('populates columnMeta with correct names', async () => {
    await raw.db('helix_test').collection('users').insertOne({ name: 'Dave', age: 40 });
    const result = await driver.query(
      JSON.stringify({ collection: 'users', operation: 'find' }),
      [],
      'helix_test',
    );
    const names = result.columnMeta.map(c => c.name);
    expect(names).toContain('_id');
    expect(names).toContain('name');
    expect(names).toContain('age');
  });
});

// ---------------------------------------------------------------------------
// query – count
// ---------------------------------------------------------------------------

describe('MongoDBDriver – query (count)', () => {
  it('returns 0 for an empty collection', async () => {
    const result = await driver.query(
      JSON.stringify({ collection: 'users', operation: 'count' }),
      [],
      'helix_test',
    );
    expect(result.rows[0]).toMatchObject({ count: 0 });
  });

  it('returns correct count after inserts', async () => {
    await raw.db('helix_test').collection('users').insertMany([{ name: 'A' }, { name: 'B' }]);
    const result = await driver.query(
      JSON.stringify({ collection: 'users', operation: 'count' }),
      [],
      'helix_test',
    );
    expect(result.rows[0]).toMatchObject({ count: 2 });
  });
});

// ---------------------------------------------------------------------------
// query – insertOne
// ---------------------------------------------------------------------------

describe('MongoDBDriver – query (insertOne)', () => {
  it('inserts a document and reports affectedRows: 1', async () => {
    const result = await driver.query(
      JSON.stringify({ collection: 'users', operation: 'insertOne', document: { name: 'Eve', age: 22 } }),
      [],
      'helix_test',
    );
    expect(result.affectedRows).toBe(1);
    const doc = await raw.db('helix_test').collection('users').findOne({ name: 'Eve' });
    expect(doc).not.toBeNull();
    expect(doc!['age']).toBe(22);
  });
});

// ---------------------------------------------------------------------------
// query – updateOne
// ---------------------------------------------------------------------------

describe('MongoDBDriver – query (updateOne)', () => {
  it('updates a document by id and reports affectedRows: 1', async () => {
    const { insertedId } = await raw.db('helix_test').collection('users').insertOne({ name: 'Frank', age: 30 });
    const result = await driver.query(
      JSON.stringify({
        collection: 'users',
        operation: 'updateOne',
        id: insertedId.toHexString(),
        update: { $set: { age: 31 } },
      }),
      [],
      'helix_test',
    );
    expect(result.affectedRows).toBe(1);
    const doc = await raw.db('helix_test').collection('users').findOne({ _id: insertedId });
    expect(doc!['age']).toBe(31);
  });

  it('reports affectedRows: 0 for a non-existent id', async () => {
    const result = await driver.query(
      JSON.stringify({
        collection: 'users',
        operation: 'updateOne',
        id: '000000000000000000000000',
        update: { $set: { age: 99 } },
      }),
      [],
      'helix_test',
    );
    expect(result.affectedRows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// query – deleteOne
// ---------------------------------------------------------------------------

describe('MongoDBDriver – query (deleteOne)', () => {
  it('deletes a document by id and reports affectedRows: 1', async () => {
    const { insertedId } = await raw.db('helix_test').collection('users').insertOne({ name: 'Grace' });
    const result = await driver.query(
      JSON.stringify({
        collection: 'users',
        operation: 'deleteOne',
        id: insertedId.toHexString(),
      }),
      [],
      'helix_test',
    );
    expect(result.affectedRows).toBe(1);
    const doc = await raw.db('helix_test').collection('users').findOne({ _id: insertedId });
    expect(doc).toBeNull();
  });

  it('reports affectedRows: 0 for a non-existent id', async () => {
    const result = await driver.query(
      JSON.stringify({
        collection: 'users',
        operation: 'deleteOne',
        id: '000000000000000000000000',
      }),
      [],
      'helix_test',
    );
    expect(result.affectedRows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getCollectionInfo
// ---------------------------------------------------------------------------

describe('MongoDBDriver – getCollectionInfo', () => {
  it('returns indexes including the default _id index', async () => {
    const info = await driver.getCollectionInfo('helix_test', 'users');
    expect(info).not.toBeNull();
    const idIndex = info!.indexes.find((i: Record<string, unknown>) => '_id' in (i['key'] as object));
    expect(idIndex).toBeDefined();
  });

  it('returns null for a non-existent collection', async () => {
    const info = await driver.getCollectionInfo('helix_test', 'nonexistent_collection');
    expect(info).toBeNull();
  });
});

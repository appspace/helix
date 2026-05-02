import { MongoClient } from 'mongodb';

const TIMEOUT_MS = 30_000;
const POLL_MS = 500;

const uri = `mongodb://${process.env['MONGO_HOST'] ?? 'localhost'}:${process.env['MONGO_PORT'] ?? 27018}/`;

async function waitForMongo(): Promise<MongoClient> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1000 });
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      return client;
    } catch (err) {
      lastError = err;
      await client.close().catch(() => {});
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`MongoDB not reachable after ${TIMEOUT_MS}ms: ${lastError}`);
}

export async function setup() {
  const client = await waitForMongo();
  try {
    const db = client.db('helix_test');
    await db.dropDatabase();
    await db.createCollection('users');
    await db.collection('users').createIndex({ name: 1 });
    // Insert and remove a sentinel so listDatabases shows helix_test immediately.
    await db.collection('users').insertOne({ _setup: true });
    await db.collection('users').deleteMany({ _setup: true });
  } finally {
    await client.close();
  }
}

export async function teardown() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    await client.db('helix_test').dropDatabase();
  } finally {
    await client.close();
  }
}

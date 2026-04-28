import pg from 'pg';

const TIMEOUT_MS = 30_000;
const POLL_MS = 500;

const config = {
  host: process.env['PG_HOST'] ?? 'localhost',
  port: Number(process.env['PG_PORT'] ?? 5433),
  user: process.env['PG_USER'] ?? 'root',
  password: process.env['PG_PASSWORD'] ?? 'root',
  database: process.env['PG_DB'] ?? 'helix_test',
};

async function waitForPostgres(): Promise<pg.Client> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client(config);
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => {});
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`Postgres not reachable after ${TIMEOUT_MS}ms: ${lastError}`);
}

export async function setup() {
  const client = await waitForPostgres();
  try {
    await client.query(`
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS users CASCADE;

      CREATE TABLE users (
        id    SERIAL PRIMARY KEY,
        name  VARCHAR(100) NOT NULL,
        age   INT,
        bio   TEXT
      );

      CREATE TABLE orders (
        id         SERIAL PRIMARY KEY,
        user_id    INT REFERENCES users(id),
        total      NUMERIC(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX idx_orders_user_id ON orders(user_id);
    `);
  } finally {
    await client.end();
  }
}

export async function teardown() {
  const client = await waitForPostgres();
  try {
    await client.query(`
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);
  } finally {
    await client.end();
  }
}

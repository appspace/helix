import mysql from 'mysql2/promise';

const TIMEOUT_MS = 30_000;
const POLL_MS = 500;

const config = {
  host: process.env['MYSQL_HOST'] ?? 'localhost',
  port: Number(process.env['MYSQL_PORT'] ?? 3307),
  user: process.env['MYSQL_USER'] ?? 'root',
  password: process.env['MYSQL_PASSWORD'] ?? 'root',
  multipleStatements: true,
};

async function waitForMySQL(): Promise<mysql.Connection> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const conn = await mysql.createConnection(config).catch(() => null);
    if (conn) {
      try {
        await conn.ping();
        return conn;
      } catch (err) {
        lastError = err;
        await conn.end();
      }
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`MySQL not reachable after ${TIMEOUT_MS}ms: ${lastError}`);
}

export async function setup() {
  const conn = await waitForMySQL();
  try {
    await conn.query(`
      DROP DATABASE IF EXISTS helix_test;
      CREATE DATABASE helix_test;
      USE helix_test;

      CREATE TABLE users (
        id   INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        age  INT,
        bio  TEXT
      );

      CREATE TABLE orders (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT,
        total      DECIMAL(10,2) NOT NULL,
        created_at DATETIME DEFAULT NOW(),
        INDEX idx_orders_user_id (user_id)
      );
    `);
  } finally {
    await conn.end();
  }
}

export async function teardown() {
  const conn = await mysql.createConnection(config);
  try {
    await conn.query('DROP DATABASE IF EXISTS helix_test');
  } finally {
    await conn.end();
  }
}

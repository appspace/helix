import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import mysql from 'mysql2/promise';
import { connect, disconnect } from '../db.js';
import { postQuery } from './query.js';
import { postInsertRow } from './insertRow.js';
import { postUpdateCell } from './updateCell.js';
import { postDeleteRow } from './deleteRow.js';

const DB_CONFIG = {
  host: process.env['MYSQL_HOST'] ?? 'localhost',
  port: Number(process.env['MYSQL_PORT'] ?? 3307),
  user: process.env['MYSQL_USER'] ?? 'root',
  password: process.env['MYSQL_PASSWORD'] ?? 'root',
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/query', postQuery);
  app.post('/api/insert-row', postInsertRow);
  app.post('/api/update-cell', postUpdateCell);
  app.post('/api/delete-row', postDeleteRow);
  return app;
}

let app: express.Express;
let raw: mysql.Connection;

beforeAll(async () => {
  await connect({ ...DB_CONFIG, database: 'helix_test' });
  raw = await mysql.createConnection({ ...DB_CONFIG, database: 'helix_test' });
  app = makeApp();
});

afterAll(async () => {
  await raw.end();
  await disconnect();
});

beforeEach(async () => {
  await raw.query('DELETE FROM orders');
  await raw.query('DELETE FROM users');
  await raw.query('ALTER TABLE users AUTO_INCREMENT = 1');
  await raw.query('ALTER TABLE orders AUTO_INCREMENT = 1');
});

// ---------------------------------------------------------------------------
// postQuery
// ---------------------------------------------------------------------------

describe('postQuery – real MySQL', () => {
  it('returns empty rows for an empty table', async () => {
    const res = await request(app)
      .post('/api/query')
      .send({ sql: 'SELECT * FROM users', schema: 'helix_test' });

    expect(res.status).toBe(200);
    expect(res.body.columns).toContain('id');
    expect(res.body.rows).toEqual([]);
  });

  it('returns inserted rows with correct types', async () => {
    await raw.query("INSERT INTO users (name, age) VALUES ('Alice', 30), ('Bob', 25)");

    const res = await request(app)
      .post('/api/query')
      .send({ sql: 'SELECT * FROM users ORDER BY id', schema: 'helix_test' });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0]).toMatchObject({ name: 'Alice', age: 30 });
    expect(res.body.rows[1]).toMatchObject({ name: 'Bob', age: 25 });
  });

  it('switches schema correctly via USE', async () => {
    // Query a known information_schema table to confirm schema switching works
    const res = await request(app)
      .post('/api/query')
      .send({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'helix_test'", schema: 'information_schema' });

    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({ SCHEMA_NAME: 'helix_test' });
  });

  it('serializes NULL as null', async () => {
    await raw.query("INSERT INTO users (name, age, bio) VALUES ('Carol', NULL, NULL)");

    const res = await request(app)
      .post('/api/query')
      .send({ sql: 'SELECT age, bio FROM users', schema: 'helix_test' });

    expect(res.status).toBe(200);
    expect(res.body.rows[0].age).toBeNull();
    expect(res.body.rows[0].bio).toBeNull();
  });

  it('returns affectedRows for an UPDATE statement', async () => {
    await raw.query("INSERT INTO users (name, age) VALUES ('Dave', 40), ('Eve', 35)");

    const res = await request(app)
      .post('/api/query')
      .send({ sql: 'UPDATE users SET age = 99', schema: 'helix_test' });

    expect(res.status).toBe(200);
    expect(res.body.affectedRows).toBe(2);
    expect(res.body.columns).toEqual([]);
    expect(res.body.rows).toEqual([]);
  });

  it('returns 400 with a useful message on bad SQL', async () => {
    const res = await request(app)
      .post('/api/query')
      .send({ sql: 'SELECT * FROM nonexistent_table_xyz', schema: 'helix_test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nonexistent_table_xyz/);
  });

  it('returns 400 on unknown schema', async () => {
    const res = await request(app)
      .post('/api/query')
      .send({ sql: 'SELECT 1', schema: 'schema_that_does_not_exist' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/schema_that_does_not_exist/i);
  });
});

// ---------------------------------------------------------------------------
// postInsertRow
// ---------------------------------------------------------------------------

describe('postInsertRow – real MySQL', () => {
  it('inserts a row and returns insertId', async () => {
    const res = await request(app)
      .post('/api/insert-row')
      .send({ schema: 'helix_test', table: 'users', values: { name: 'Frank', age: 28 } });

    expect(res.status).toBe(200);
    expect(res.body.insertId).toBe(1);
    expect(res.body.affectedRows).toBe(1);

    const [rows] = await raw.query<mysql.RowDataPacket[]>('SELECT * FROM users');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Frank', age: 28 });
  });

  it('inserts a row with a NULL value', async () => {
    const res = await request(app)
      .post('/api/insert-row')
      .send({ schema: 'helix_test', table: 'users', values: { name: 'Grace', age: null } });

    expect(res.status).toBe(200);
    const [rows] = await raw.query<mysql.RowDataPacket[]>('SELECT age FROM users');
    expect(rows[0].age).toBeNull();
  });

  it('returns 400 when inserting into a nonexistent table', async () => {
    const res = await request(app)
      .post('/api/insert-row')
      .send({ schema: 'helix_test', table: 'ghost', values: { x: 1 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ghost/);
  });
});

// ---------------------------------------------------------------------------
// postUpdateCell
// ---------------------------------------------------------------------------

describe('postUpdateCell – real MySQL', () => {
  beforeEach(async () => {
    await raw.query("INSERT INTO users (id, name, age) VALUES (1, 'Heidi', 22)");
  });

  it('updates a cell by primary key', async () => {
    const res = await request(app)
      .post('/api/update-cell')
      .send({
        schema: 'helix_test',
        table: 'users',
        where: [{ column: 'id', value: 1 }],
        column: 'age',
        value: 99,
      });

    expect(res.status).toBe(200);
    expect(res.body.affectedRows).toBe(1);

    const [rows] = await raw.query<mysql.RowDataPacket[]>('SELECT age FROM users WHERE id = 1');
    expect(rows[0].age).toBe(99);
  });

  it('updates a cell to NULL', async () => {
    const res = await request(app)
      .post('/api/update-cell')
      .send({
        schema: 'helix_test',
        table: 'users',
        where: [{ column: 'id', value: 1 }],
        column: 'bio',
        value: null,
      });

    expect(res.status).toBe(200);
    const [rows] = await raw.query<mysql.RowDataPacket[]>('SELECT bio FROM users WHERE id = 1');
    expect(rows[0].bio).toBeNull();
  });

  it('returns affectedRows = 0 when WHERE matches nothing', async () => {
    const res = await request(app)
      .post('/api/update-cell')
      .send({
        schema: 'helix_test',
        table: 'users',
        where: [{ column: 'id', value: 999 }],
        column: 'age',
        value: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.affectedRows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// postDeleteRow
// ---------------------------------------------------------------------------

describe('postDeleteRow – real MySQL', () => {
  beforeEach(async () => {
    await raw.query("INSERT INTO users (id, name, age) VALUES (1, 'Ivan', 45), (2, 'Judy', 38)");
  });

  it('deletes a row by primary key', async () => {
    const res = await request(app)
      .post('/api/delete-row')
      .send({
        schema: 'helix_test',
        table: 'users',
        where: [{ column: 'id', value: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.affectedRows).toBe(1);

    const [rows] = await raw.query<mysql.RowDataPacket[]>('SELECT * FROM users');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Judy' });
  });

  it('returns affectedRows = 0 when WHERE matches nothing', async () => {
    const res = await request(app)
      .post('/api/delete-row')
      .send({
        schema: 'helix_test',
        table: 'users',
        where: [{ column: 'id', value: 999 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.affectedRows).toBe(0);
  });

  it('deletes with a compound WHERE clause', async () => {
    const res = await request(app)
      .post('/api/delete-row')
      .send({
        schema: 'helix_test',
        table: 'users',
        where: [{ column: 'id', value: 2 }, { column: 'name', value: 'Judy' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.affectedRows).toBe(1);
  });
});

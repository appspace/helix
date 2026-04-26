## Problem

`server/src/routes/schema.ts` — `getSchema` handler fires five `await pool.query(...)` calls back-to-back:

1. `information_schema.TABLES` (table list)
2. `information_schema.COLUMNS` (all columns for schema)
3. `information_schema.VIEWS`
4. `information_schema.ROUTINES` (procedures)
5. `information_schema.TRIGGERS`

Each call waits for the previous one to complete before starting, so total latency is the sum of all five round-trips. On a remote database with even 20 ms per query that is 100 ms of avoidable serial waiting every time a schema is loaded or refreshed.

All five queries are fully independent — none of their results are used as input to another.

## Expected fix

Replace the sequential awaits with `Promise.all`:

```ts
const [
  [tables],
  [columns],
  [views],
  [procedures],
  [triggers],
] = await Promise.all([
  pool.query<RowDataPacket[]>(`SELECT ... FROM information_schema.TABLES ...`, [schema]),
  pool.query<RowDataPacket[]>(`SELECT ... FROM information_schema.COLUMNS ...`, [schema]),
  pool.query<RowDataPacket[]>(`SELECT ... FROM information_schema.VIEWS ...`, [schema]),
  pool.query<RowDataPacket[]>(`SELECT ... FROM information_schema.ROUTINES ...`, [schema]),
  pool.query<RowDataPacket[]>(`SELECT ... FROM information_schema.TRIGGERS ...`, [schema]),
]);
```

This reduces schema-load latency to the slowest single query rather than their sum.

## File

`server/src/routes/schema.ts` — `getSchema` handler (lines 30–69)

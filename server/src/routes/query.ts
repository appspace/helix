import type { RequestHandler } from 'express';
import type { RowDataPacket, FieldPacket } from 'mysql2/promise';
import { getPool } from '../db.js';

export const postQuery: RequestHandler = async (req, res) => {
  const { sql, schema } = req.body as { sql: string; schema?: string };

  if (!sql?.trim()) {
    res.status(400).json({ error: 'sql is required.' });
    return;
  }

  try {
    const pool = getPool();

    if (schema) {
      await pool.query(`USE \`${schema.replace(/`/g, '')}\``);
    }

    const start = Date.now();
    const [rows, fields]: [RowDataPacket[], FieldPacket[]] = await pool.query(sql) as [RowDataPacket[], FieldPacket[]];
    const executionTime = Date.now() - start;

    // Non-SELECT statements (INSERT, UPDATE, DELETE, etc.)
    if (!Array.isArray(rows)) {
      const result = rows as unknown as { affectedRows: number; insertId: number };
      res.json({
        columns: [],
        rows: [],
        affectedRows: result.affectedRows ?? 0,
        insertId: result.insertId ?? null,
        executionTime,
      });
      return;
    }

    const columns = fields.map(f => f.name);
    const PRI_KEY_FLAG = 2;
    const columnMeta = fields.map(f => {
      const flagsNum = typeof f.flags === 'number'
        ? f.flags
        : Array.isArray(f.flags) && f.flags.includes('PRI_KEY') ? PRI_KEY_FLAG : 0;
      return {
        name: f.name,
        orgName: f.orgName ?? f.name,
        table: f.table ?? '',
        orgTable: f.orgTable ?? '',
        pk: (flagsNum & PRI_KEY_FLAG) === PRI_KEY_FLAG,
      };
    });

    // Serialize rows — convert Buffer/Date/BigInt to plain values
    const serialized = rows.map(row => {
      const out: Record<string, unknown> = {};
      for (const col of columns) {
        const val = row[col];
        if (val === null || val === undefined) {
          out[col] = null;
        } else if (Buffer.isBuffer(val)) {
          out[col] = val.toString('hex');
        } else if (val instanceof Date) {
          out[col] = val.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
        } else if (typeof val === 'bigint') {
          out[col] = val.toString();
        } else {
          out[col] = val;
        }
      }
      return out;
    });

    res.json({ columns, columnMeta, rows: serialized, executionTime });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

import type { RequestHandler } from 'express';
import type { RowDataPacket, FieldPacket } from 'mysql2/promise';
import { withSchema } from '../db.js';

export const postQuery: RequestHandler = async (req, res) => {
  const { sql, schema } = req.body as { sql: string; schema?: string };

  if (!sql?.trim()) {
    res.status(400).json({ error: 'sql is required.' });
    return;
  }

  try {
    await withSchema(schema, async (conn) => {
      const start = Date.now();
      const [rows, fields]: [RowDataPacket[], FieldPacket[]] = await conn.query(sql) as [RowDataPacket[], FieldPacket[]];
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
      const NOT_NULL_FLAG = 1;
      const PRI_KEY_FLAG = 2;
      const UNIQUE_KEY_FLAG = 4;
      const columnMeta = fields.map(f => {
        let flagsNum = 0;
        if (typeof f.flags === 'number') {
          flagsNum = f.flags;
        } else if (Array.isArray(f.flags)) {
          if (f.flags.includes('NOT_NULL')) flagsNum |= NOT_NULL_FLAG;
          if (f.flags.includes('PRI_KEY')) flagsNum |= PRI_KEY_FLAG;
          if (f.flags.includes('UNIQUE_KEY')) flagsNum |= UNIQUE_KEY_FLAG;
        }
        return {
          name: f.name,
          orgName: f.orgName ?? f.name,
          table: f.table ?? '',
          orgTable: f.orgTable ?? '',
          pk: (flagsNum & PRI_KEY_FLAG) === PRI_KEY_FLAG,
          unique: (flagsNum & UNIQUE_KEY_FLAG) === UNIQUE_KEY_FLAG,
          notNull: (flagsNum & NOT_NULL_FLAG) === NOT_NULL_FLAG,
          mysqlType: f.columnType ?? f.type ?? 0,
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
            // mysql2 gives a Date for DATETIME/TIMESTAMP; .toISOString() is always UTC.
            // Assumes the MySQL server is also UTC — displayed time will be wrong otherwise.
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
};

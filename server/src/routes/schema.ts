import type { RequestHandler } from 'express';
import mysql from 'mysql2/promise';
import { getPool } from '../db.js';

export const getSchemas: RequestHandler = async (_req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys')
       ORDER BY SCHEMA_NAME`
    );
    res.json({ schemas: rows.map(r => r['name'] as string) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
};

export const getSchema: RequestHandler = async (req, res) => {
  const schema = req.query['schema'] as string;
  if (!schema) {
    res.status(400).json({ error: 'schema query param is required.' });
    return;
  }

  try {
    const pool = getPool();

    const [
      [tables],
      [columns],
      [views],
      [procedures],
      [triggers],
    ] = await Promise.all([
      pool.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME AS name, TABLE_ROWS AS row_count, TABLE_COMMENT AS comment
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
        [schema],
      ),
      pool.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, COLUMN_TYPE AS col_type,
                DATA_TYPE AS data_type,
                IF(COLUMN_KEY = 'PRI', 1, 0) AS is_pk,
                IF(IS_NULLABLE = 'YES', 1, 0) AS nullable,
                COLUMN_DEFAULT AS col_default,
                EXTRA AS extra,
                COLUMN_COMMENT AS comment
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [schema],
      ),
      pool.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME AS name FROM information_schema.VIEWS
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [schema],
      ),
      pool.query<mysql.RowDataPacket[]>(
        `SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES
         WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'
         ORDER BY ROUTINE_NAME`,
        [schema],
      ),
      pool.query<mysql.RowDataPacket[]>(
        `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
         WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
        [schema],
      ),
    ]);

    const colsByTable = new Map<string, {
      name: string;
      type: string;
      dataType: string;
      pk: boolean;
      nullable: boolean;
      default: string | null;
      autoIncrement: boolean;
      comment: string;
    }[]>();
    for (const col of columns) {
      const tname = col['tbl'] as string;
      if (!colsByTable.has(tname)) colsByTable.set(tname, []);
      const extra = ((col['extra'] as string) ?? '').toLowerCase();
      colsByTable.get(tname)!.push({
        name: col['col'] as string,
        type: col['col_type'] as string,
        dataType: ((col['data_type'] as string) ?? '').toLowerCase(),
        pk: Boolean(col['is_pk']),
        nullable: Boolean(col['nullable']),
        default: (col['col_default'] as string | null) ?? null,
        autoIncrement: extra.includes('auto_increment'),
        comment: (col['comment'] as string) ?? '',
      });
    }

    res.json({
      tables: tables.map(t => ({
        name: t['name'] as string,
        rows: t['row_count'] as number,
        comment: (t['comment'] as string) ?? '',
        columns: colsByTable.get(t['name'] as string) ?? [],
      })),
      views: views.map(v => v['name'] as string),
      procedures: procedures.map(p => p['name'] as string),
      triggers: triggers.map(t => t['name'] as string),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
};

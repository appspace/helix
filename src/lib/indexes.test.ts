import { describe, it, expect } from 'vitest';
import { indexMarkFor, describeIndexMark } from './indexes';
import type { ColumnMeta, SchemaData, SchemaIndex } from '../api';

function schema(indexes: SchemaIndex[]): SchemaData {
  return {
    tables: [{ name: 'orders', rows: 0, comment: '', columns: [], indexes }],
    views: [],
    procedures: [],
    triggers: [],
  };
}

function meta(orgName: string, orgTable = 'orders'): ColumnMeta {
  return {
    name: orgName, orgName, table: orgTable, orgTable,
    pk: false, unique: false, notNull: false, mysqlType: 0,
  };
}

const PRIMARY: SchemaIndex = { name: 'PRIMARY', unique: true, columns: ['id'], type: 'BTREE' };
const COMPOSITE: SchemaIndex = {
  name: 'idx_user_created', unique: false, columns: ['user_id', 'created_at'], type: 'BTREE',
};

describe('indexMarkFor', () => {
  it('marks the leftmost column of a single-column index as leading', () => {
    const mark = indexMarkFor(schema([PRIMARY]), meta('id'));
    expect(mark).toEqual({
      kind: 'leading',
      memberships: [{ index: 'PRIMARY', unique: true, position: 1, columns: ['id'], type: 'BTREE' }],
    });
  });

  it('marks the leftmost column of a composite index as leading', () => {
    expect(indexMarkFor(schema([COMPOSITE]), meta('user_id'))?.kind).toBe('leading');
  });

  it('marks a later column of a composite index as trailing', () => {
    const mark = indexMarkFor(schema([COMPOSITE]), meta('created_at'));
    expect(mark?.kind).toBe('trailing');
    expect(mark?.memberships[0].position).toBe(2);
  });

  it('returns null for a column in no index', () => {
    expect(indexMarkFor(schema([PRIMARY, COMPOSITE]), meta('total'))).toBeNull();
  });

  it('returns null when the table is not in the loaded schema', () => {
    expect(indexMarkFor(schema([PRIMARY]), meta('id', 'other_table'))).toBeNull();
  });

  it('returns null when the column has no originating table (expression, aggregate, non-MySQL driver)', () => {
    const expression = { ...meta('id'), orgTable: '' };
    expect(indexMarkFor(schema([PRIMARY]), expression)).toBeNull();
  });

  it('returns null without schema data or column metadata', () => {
    expect(indexMarkFor(undefined, meta('id'))).toBeNull();
    expect(indexMarkFor(schema([PRIMARY]), undefined)).toBeNull();
  });

  it('matches table and column names case-insensitively', () => {
    expect(indexMarkFor(schema([PRIMARY]), meta('ID', 'Orders'))?.kind).toBe('leading');
  });

  it('reports every index the column belongs to, leftmost membership first', () => {
    const trailingFirst = schema([COMPOSITE, { name: 'idx_created', unique: false, columns: ['created_at'], type: 'BTREE' }]);
    const mark = indexMarkFor(trailingFirst, meta('created_at'));
    expect(mark?.kind).toBe('leading');
    expect(mark?.memberships.map(m => m.index)).toEqual(['idx_created', 'idx_user_created']);
  });

  it('tolerates a table with no indexes', () => {
    expect(indexMarkFor(schema([]), meta('id'))).toBeNull();
  });
});

describe('describeIndexMark', () => {
  it('describes a single-column unique index', () => {
    const text = describeIndexMark(indexMarkFor(schema([PRIMARY]), meta('id'))!);
    expect(text).toBe(
      'Indexed — a filter on this column alone can use an index\n• PRIMARY — unique index',
    );
  });

  it('describes a trailing composite position with the full column list', () => {
    const text = describeIndexMark(indexMarkFor(schema([COMPOSITE]), meta('created_at'))!);
    expect(text).toContain('only as a later column of a composite index');
    expect(text).toContain('• idx_user_created — 2nd of 2 columns (user_id, created_at)');
  });

  it('names a non-btree access method', () => {
    const fulltext: SchemaIndex = { name: 'idx_body', unique: false, columns: ['body'], type: 'FULLTEXT' };
    const text = describeIndexMark(indexMarkFor(schema([fulltext]), meta('body'))!);
    expect(text).toContain('• idx_body — index FULLTEXT');
  });

  it('does not promise a plain filter works when the only leading index is non-btree', () => {
    const fulltext: SchemaIndex = { name: 'idx_body', unique: false, columns: ['body'], type: 'FULLTEXT' };
    const text = describeIndexMark(indexMarkFor(schema([fulltext]), meta('body'))!);
    expect(text).toContain('leads a FULLTEXT index, so only a matching FULLTEXT predicate can use it');
  });

  it('keeps the plain-filter headline when the column also leads a btree index', () => {
    const indexes: SchemaIndex[] = [
      { name: 'idx_body', unique: false, columns: ['body'], type: 'FULLTEXT' },
      { name: 'idx_body_btree', unique: false, columns: ['body'], type: 'BTREE' },
    ];
    const text = describeIndexMark(indexMarkFor(schema(indexes), meta('body'))!);
    expect(text).toContain('a filter on this column alone can use an index');
  });

  it('leaves the default btree access method unnamed', () => {
    const lower: SchemaIndex = { name: 'idx_total', unique: false, columns: ['total'], type: 'btree' };
    const text = describeIndexMark(indexMarkFor(schema([lower]), meta('total'))!);
    expect(text).toContain('• idx_total — index');
    expect(text).not.toContain('btree');
  });

  it('lists one line per index for a column in several indexes', () => {
    const many = schema([COMPOSITE, { name: 'idx_created', unique: false, columns: ['created_at'], type: 'BTREE' }]);
    const text = describeIndexMark(indexMarkFor(many, meta('created_at'))!);
    expect(text.split('\n')).toHaveLength(3);
  });
});

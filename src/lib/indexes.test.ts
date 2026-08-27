import { describe, it, expect } from 'vitest';
import { indexMarkFor, describeIndexMark, INDEX_MARK_LEGEND } from './indexes';
import type { ColumnMeta, SchemaData, SchemaIndex } from '../api';

function schema(indexes: SchemaIndex[]): SchemaData {
  return {
    tables: [{ name: 'orders', rows: 0, comment: '', columns: [], indexes, foreignKeys: [] }],
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
    const tip = describeIndexMark(indexMarkFor(schema([PRIMARY]), meta('id'))!);
    expect(tip.memberships).toEqual(['PRIMARY — unique index']);
    expect(tip.caveat).toBeNull();
  });

  it('describes a trailing composite position with the full column list', () => {
    const tip = describeIndexMark(indexMarkFor(schema([COMPOSITE]), meta('created_at'))!);
    expect(tip.memberships).toEqual(['idx_user_created — 2nd of 2 columns (user_id, created_at)']);
  });

  it('names a non-btree access method', () => {
    const fulltext: SchemaIndex = { name: 'idx_body', unique: false, columns: ['body'], type: 'FULLTEXT' };
    const tip = describeIndexMark(indexMarkFor(schema([fulltext]), meta('body'))!);
    expect(tip.memberships).toEqual(['idx_body — index FULLTEXT']);
  });

  it('caveats a leading column whose only index is non-btree', () => {
    const fulltext: SchemaIndex = { name: 'idx_body', unique: false, columns: ['body'], type: 'FULLTEXT' };
    const tip = describeIndexMark(indexMarkFor(schema([fulltext]), meta('body'))!);
    expect(tip.caveat).toBe("Only a matching FULLTEXT predicate can use this index — an ordinary comparison can't.");
  });

  it('drops the caveat when the column also leads a btree index', () => {
    const indexes: SchemaIndex[] = [
      { name: 'idx_body', unique: false, columns: ['body'], type: 'FULLTEXT' },
      { name: 'idx_body_btree', unique: false, columns: ['body'], type: 'BTREE' },
    ];
    const tip = describeIndexMark(indexMarkFor(schema(indexes), meta('body'))!);
    expect(tip.caveat).toBeNull();
  });

  it('never caveats a trailing column — the legend already says it needs help', () => {
    const fulltext: SchemaIndex = { name: 'idx_pair', unique: false, columns: ['other', 'body'], type: 'FULLTEXT' };
    const tip = describeIndexMark(indexMarkFor(schema([fulltext]), meta('body'))!);
    expect(tip.caveat).toBeNull();
  });

  it('leaves the default btree access method unnamed', () => {
    const lower: SchemaIndex = { name: 'idx_total', unique: false, columns: ['total'], type: 'btree' };
    const tip = describeIndexMark(indexMarkFor(schema([lower]), meta('total'))!);
    expect(tip.memberships).toEqual(['idx_total — index']);
  });

  it('lists one line per index for a column in several indexes', () => {
    const many = schema([COMPOSITE, { name: 'idx_created', unique: false, columns: ['created_at'], type: 'BTREE' }]);
    const tip = describeIndexMark(indexMarkFor(many, meta('created_at'))!);
    expect(tip.memberships).toEqual([
      'idx_created — index',
      'idx_user_created — 2nd of 2 columns (user_id, created_at)',
    ]);
  });
});

describe('INDEX_MARK_LEGEND', () => {
  it('covers both mark kinds, leading first', () => {
    expect(INDEX_MARK_LEGEND.map(l => l.kind)).toEqual(['leading', 'trailing']);
  });
});

import { describe, it, expect } from 'vitest';
import { extractTableRefs, contextAtCaret, expectedSlot } from './sqlContext';

describe('extractTableRefs', () => {
  it('returns a single bare table with table-name fallback alias', () => {
    expect(extractTableRefs('SELECT * FROM users')).toEqual([
      { table: 'users', alias: 'users' },
    ]);
  });

  it('reads an implicit alias (no AS keyword)', () => {
    expect(extractTableRefs('SELECT u.id FROM users u WHERE u.id = 1')).toEqual([
      { table: 'users', alias: 'u' },
    ]);
  });

  it('reads an explicit AS alias', () => {
    expect(extractTableRefs('SELECT * FROM users AS u')).toEqual([
      { table: 'users', alias: 'u' },
    ]);
  });

  it('strips schema qualifier and keeps the table name', () => {
    expect(extractTableRefs('SELECT * FROM `db`.`users` u')).toEqual([
      { table: 'users', alias: 'u' },
    ]);
  });

  it('unquotes backtick / double-quote / bracket identifiers', () => {
    expect(extractTableRefs('SELECT * FROM `users` `u`')).toEqual([
      { table: 'users', alias: 'u' },
    ]);
    expect(extractTableRefs('SELECT * FROM "users" "u"')).toEqual([
      { table: 'users', alias: 'u' },
    ]);
    expect(extractTableRefs('SELECT * FROM [users] [u]')).toEqual([
      { table: 'users', alias: 'u' },
    ]);
  });

  it('captures every JOIN variant alongside the FROM', () => {
    const sql = `
      SELECT *
      FROM users u
      INNER JOIN orders o ON o.user_id = u.id
      LEFT JOIN payments AS p ON p.order_id = o.id
      CROSS JOIN coupons c
    `;
    expect(extractTableRefs(sql)).toEqual([
      { table: 'users', alias: 'u' },
      { table: 'orders', alias: 'o' },
      { table: 'payments', alias: 'p' },
      { table: 'coupons', alias: 'c' },
    ]);
  });

  it('treats a SQL keyword in the alias slot as the next clause, not an alias', () => {
    // The bare word `WHERE` after `users` is the WHERE clause keyword — it
    // must not be captured as the table's alias.
    expect(extractTableRefs('SELECT * FROM users WHERE id = 1')).toEqual([
      { table: 'users', alias: 'users' },
    ]);
    expect(extractTableRefs('SELECT * FROM users LEFT JOIN orders ON true')).toEqual([
      { table: 'users', alias: 'users' },
      { table: 'orders', alias: 'orders' },
    ]);
  });

  it('ignores FROM / JOIN tokens that appear inside string literals or comments', () => {
    expect(extractTableRefs("SELECT 'FROM stash' FROM real_table")).toEqual([
      { table: 'real_table', alias: 'real_table' },
    ]);
    expect(extractTableRefs('SELECT * /* FROM commented_out */ FROM real_table')).toEqual([
      { table: 'real_table', alias: 'real_table' },
    ]);
    expect(extractTableRefs('-- FROM line_comment\nSELECT * FROM real_table')).toEqual([
      { table: 'real_table', alias: 'real_table' },
    ]);
  });

  it('is case-insensitive on the FROM / JOIN keywords', () => {
    expect(extractTableRefs('select * from users u left join orders o on true')).toEqual([
      { table: 'users', alias: 'u' },
      { table: 'orders', alias: 'o' },
    ]);
  });

  it('returns [] when there is no FROM clause', () => {
    expect(extractTableRefs('SELECT 1 + 1')).toEqual([]);
  });
});

describe('contextAtCaret', () => {
  it('returns null on whitespace with no identifier under the caret', () => {
    expect(contextAtCaret('SELECT ', 7)).toBeNull();
  });

  it('captures a bare identifier prefix and its start offset', () => {
    const text = 'SELECT use';
    expect(contextAtCaret(text, text.length)).toEqual({
      prefix: 'use', start: 7, qualifier: null,
    });
  });

  it('detects a qualified prefix like `alias.col`', () => {
    const text = 'SELECT u.na';
    expect(contextAtCaret(text, text.length)).toEqual({
      prefix: 'na', start: 9, qualifier: 'u',
    });
  });

  it('detects a bare qualifier with empty prefix (just typed the dot)', () => {
    const text = 'SELECT u.';
    expect(contextAtCaret(text, text.length)).toEqual({
      prefix: '', start: 9, qualifier: 'u',
    });
  });

  it('unwraps a backtick-quoted qualifier', () => {
    const text = 'SELECT `users`.id';
    expect(contextAtCaret(text, text.length)).toMatchObject({
      prefix: 'id', qualifier: 'users',
    });
  });
});

describe('expectedSlot', () => {
  // Helper: given a string with a `|` caret marker, return the slot at that pos.
  function slot(textWithCaret: string) {
    const i = textWithCaret.indexOf('|');
    const text = textWithCaret.slice(0, i) + textWithCaret.slice(i + 1);
    const ctx = contextAtCaret(text, i);
    if (!ctx) throw new Error('contextAtCaret returned null — fix the test fixture');
    return expectedSlot(text, ctx.start, ctx.qualifier);
  }

  it('at the start of a query expects only statement-starter keywords', () => {
    expect(slot('SELE|')).toEqual({ keywords: 'statement', tables: false, columns: false });
  });

  it('right after a semicolon resets to statement-starters', () => {
    expect(slot('SELECT 1; SEL|')).toEqual({ keywords: 'statement', tables: false, columns: false });
  });

  it('directly after FROM expects tables only — no columns or keywords', () => {
    expect(slot('SELECT * FROM us|')).toEqual({ keywords: 'none', tables: true, columns: false });
  });

  it('directly after JOIN expects tables only', () => {
    expect(slot('SELECT * FROM a JOIN b|')).toEqual({ keywords: 'none', tables: true, columns: false });
  });

  it('after WHERE expects columns plus expression keywords', () => {
    expect(slot('SELECT * FROM users WHERE na|')).toEqual({ keywords: 'expr', tables: false, columns: true });
  });

  it('after GROUP expects only the BY continuation keyword', () => {
    expect(slot('SELECT * FROM users GROUP x|')).toEqual({ keywords: 'by', tables: false, columns: false });
  });

  it('a qualified prefix is always column-only — even after FROM', () => {
    expect(slot('SELECT * FROM users u WHERE u.na|')).toEqual({ keywords: 'none', tables: false, columns: true });
  });

  it('after a closing backtick of a table name falls into the permissive any-slot', () => {
    // Matches the bug from the screenshot — typing `wh` on a new line right
    // after `FROM \`tbl\`` should expose clause keywords (WHERE etc.).
    expect(slot('SELECT *\nFROM `users`\nwh|')).toEqual({ keywords: 'any', tables: true, columns: true });
  });
});

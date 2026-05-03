import { describe, it, expect } from 'vitest';
import { formatSqlValue, buildInsertSql } from './sql';

describe('formatSqlValue', () => {
  it('renders NULL for null', () => {
    expect(formatSqlValue(null)).toBe('NULL');
  });

  it('wraps strings in single quotes', () => {
    expect(formatSqlValue('Alice')).toBe("'Alice'");
  });

  it('escapes embedded single quotes', () => {
    expect(formatSqlValue("O'Brien")).toBe("'O\\'Brien'");
  });

  it('escapes embedded backslashes', () => {
    expect(formatSqlValue('C:\\Users')).toBe("'C:\\\\Users'");
  });

  it('escapes backslash before single quote', () => {
    expect(formatSqlValue("it\\'s")).toBe("'it\\\\\\'s'");
  });

  it('passes integers through unquoted', () => {
    expect(formatSqlValue(42)).toBe('42');
  });

  it('passes floats through unquoted', () => {
    expect(formatSqlValue(3.14)).toBe('3.14');
  });

  it('handles empty string', () => {
    expect(formatSqlValue('')).toBe("''");
  });

  it('renders true/false for booleans', () => {
    expect(formatSqlValue(true)).toBe('true');
    expect(formatSqlValue(false)).toBe('false');
  });
});

describe('buildInsertSql', () => {
  it('produces a valid single-row INSERT', () => {
    expect(buildInsertSql('users', { name: 'Eve', age: 28, email: null })).toBe(
      "INSERT INTO `users`\n  (`name`, `age`, `email`)\nVALUES\n  ('Eve', 28, NULL);"
    );
  });

  it('handles no columns (edge case)', () => {
    expect(buildInsertSql('users', {})).toBe('INSERT INTO `users` () VALUES ();');
  });

  it('backtick-escapes column names', () => {
    const sql = buildInsertSql('t', { col: 'v' });
    expect(sql).toContain('`col`');
  });

  it('backtick-escapes table name', () => {
    const sql = buildInsertSql('my table', { col: 1 });
    expect(sql).toContain('`my table`');
  });
});

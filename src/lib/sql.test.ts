import { describe, it, expect } from 'vitest';
import { formatSqlValue, buildInsertSql, parseEnumValues } from './sql';

describe('parseEnumValues', () => {
  it('parses a standard enum type', () => {
    expect(parseEnumValues("enum('active','inactive','pending')")).toEqual(['active', 'inactive', 'pending']);
  });

  it('parses a single-value enum', () => {
    expect(parseEnumValues("enum('only')")).toEqual(['only']);
  });

  it('unescapes single quotes inside values', () => {
    expect(parseEnumValues("enum('O\\'Brien','Smith')")).toEqual(["O'Brien", 'Smith']);
  });

  it('unescapes backslashes inside values', () => {
    expect(parseEnumValues("enum('C:\\\\path')")).toEqual(['C:\\path']);
  });

  it('returns null for non-enum types', () => {
    expect(parseEnumValues('varchar(100)')).toBeNull();
    expect(parseEnumValues('int')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseEnumValues('')).toBeNull();
  });

  it('is case-insensitive for the ENUM keyword', () => {
    expect(parseEnumValues("ENUM('a','b')")).toEqual(['a', 'b']);
  });
});

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

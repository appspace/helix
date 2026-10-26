import { describe, it, expect } from 'vitest';
import { tokenizeSql, tokenizeJson, type Token } from './sqlHighlight';

const join = (tokens: Token[]) => tokens.map(t => t.text).join('');
// Non-whitespace tokens only, so assertions don't depend on how spaces merge.
const significant = (tokens: Token[]) =>
  tokens.filter(t => t.text.trim() !== '').map(t => [t.type, t.text.trim()]);

describe('tokenizeSql', () => {
  it('round-trips the input exactly', () => {
    const inputs = [
      '',
      'SELECT * FROM users',
      "SELECT 'it''s', \"col\", `tbl`.`c` FROM t -- trailing\n/* block */ WHERE x >= 1.5e3;",
      "SELECT 'unterminated",
      '/* unterminated',
      'SELECT\tcount( * )\r\nFROM [dbo].[t]',
    ];
    for (const sql of inputs) expect(join(tokenizeSql(sql))).toBe(sql);
  });

  it('classifies keywords case-insensitively', () => {
    expect(significant(tokenizeSql('select id from users'))).toEqual([
      ['keyword', 'select'], ['plain', 'id'], ['keyword', 'from'], ['plain', 'users'],
    ]);
  });

  it('colours strings, numbers and comments', () => {
    expect(significant(tokenizeSql("WHERE a = 'x' AND b = 42 -- note"))).toEqual([
      ['keyword', 'WHERE'], ['plain', 'a'], ['operator', '='], ['string', "'x'"],
      ['keyword', 'AND'], ['plain', 'b'], ['operator', '='], ['number', '42'],
      ['comment', '-- note'],
    ]);
  });

  it('handles escaped quotes inside strings', () => {
    expect(significant(tokenizeSql("'a\\'b' 'c''d'"))).toEqual([
      ['string', "'a\\'b'"], ['string', "'c''d'"],
    ]);
  });

  it('treats a call as a function but keeps keyword calls as keywords', () => {
    expect(significant(tokenizeSql('COUNT(*), IN (1)'))).toEqual([
      ['function', 'COUNT'], ['plain', '('], ['operator', '*'], ['plain', '),'],
      ['keyword', 'IN'], ['plain', '('], ['number', '1'], ['plain', ')'],
    ]);
  });

  it('colours data types', () => {
    expect(significant(tokenizeSql('id BIGINT, name VARCHAR(10)'))).toEqual([
      ['plain', 'id'], ['type', 'BIGINT'], ['plain', ', name'],
      ['type', 'VARCHAR'], ['plain', '('], ['number', '10'], ['plain', ')'],
    ]);
  });

  it('does not treat a qualified member as a keyword', () => {
    expect(significant(tokenizeSql('o.order'))).toEqual([['plain', 'o.order']]);
  });

  it('keeps digits inside identifiers out of numbers', () => {
    expect(significant(tokenizeSql('t1.col2'))).toEqual([['plain', 't1.col2']]);
  });

  it('marks quoted identifiers', () => {
    expect(significant(tokenizeSql('`my table`.[c]'))).toEqual([
      ['identifier', '`my table`'], ['plain', '.'], ['identifier', '[c]'],
    ]);
  });

  it('reads hex and leading-dot numbers', () => {
    expect(significant(tokenizeSql('0xFF .5'))).toEqual([['number', '0xFF'], ['number', '.5']]);
  });

  it('treats # as a MySQL line comment', () => {
    expect(significant(tokenizeSql('# hi\nSELECT'))).toEqual([['comment', '# hi'], ['keyword', 'SELECT']]);
  });

  it('treats # as an operator when hash comments are off (Postgres XOR)', () => {
    const sql = 'SELECT 5 # 3';
    const tokens = tokenizeSql(sql, { hashComments: false });
    expect(join(tokens)).toBe(sql);
    expect(significant(tokens)).toEqual([
      ['keyword', 'SELECT'], ['number', '5'], ['operator', '#'], ['number', '3'],
    ]);
  });
});

describe('tokenizeJson', () => {
  it('round-trips and separates keys from values', () => {
    const src = '{ "collection": "users", "limit": -10, "x": true }';
    const tokens = tokenizeJson(src);
    expect(join(tokens)).toBe(src);
    expect(significant(tokens)).toEqual([
      ['plain', '{'], ['identifier', '"collection"'], ['plain', ':'], ['string', '"users"'],
      ['plain', ','], ['identifier', '"limit"'], ['plain', ':'], ['number', '-10'],
      ['plain', ','], ['identifier', '"x"'], ['plain', ':'], ['keyword', 'true'], ['plain', '}'],
    ]);
  });
});

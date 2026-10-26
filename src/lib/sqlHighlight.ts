// Tokenizer for the editor's syntax-highlight layer. Like sqlContext, this is
// not a parser: it splits text into coloured runs. The only hard requirement
// is that concatenating every token's `text` reproduces the input exactly —
// the highlight layer sits behind the textarea, so any drift misaligns glyphs.

export type TokenType =
  | 'keyword' | 'function' | 'type' | 'string' | 'number'
  | 'comment' | 'operator' | 'identifier' | 'plain';

export interface Token {
  type: TokenType;
  text: string;
}

const KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'on',
  'join', 'inner', 'outer', 'left', 'right', 'cross', 'full', 'natural',
  'straight_join', 'using', 'group', 'order', 'by', 'having', 'limit', 'offset',
  'as', 'lateral', 'union', 'intersect', 'except', 'with', 'recursive',
  'distinct', 'all', 'any', 'some', 'exists', 'asc', 'desc', 'true', 'false',
  'between', 'like', 'ilike', 'rlike', 'regexp', 'escape', 'case', 'when',
  'then', 'else', 'end', 'insert', 'into', 'values', 'value', 'update', 'set',
  'delete', 'replace', 'returning', 'create', 'alter', 'drop', 'truncate',
  'rename', 'table', 'view', 'index', 'database', 'schema', 'procedure',
  'function', 'trigger', 'if', 'primary', 'key', 'foreign', 'references',
  'unique', 'constraint', 'default', 'check', 'auto_increment', 'add',
  'column', 'modify', 'change', 'after', 'first', 'cascade', 'restrict',
  'show', 'tables', 'columns', 'databases', 'schemas', 'describe', 'explain',
  'analyze', 'use', 'begin', 'start', 'transaction', 'commit', 'rollback',
  'savepoint', 'grant', 'revoke', 'partition', 'window', 'over', 'rows',
  'range', 'preceding', 'following', 'unbounded', 'current', 'row', 'for',
  'lock', 'share', 'mode', 'duplicate', 'ignore', 'conflict', 'do', 'nothing',
  'interval', 'collate', 'character', 'charset', 'engine', 'temporary',
  'unsigned', 'zerofill', 'signed', 'nulls', 'last', 'fetch', 'next', 'only',
]);

// Data types read better in their own colour than as keywords.
const TYPES = new Set([
  'int', 'integer', 'tinyint', 'smallint', 'mediumint', 'bigint', 'serial',
  'bigserial', 'decimal', 'numeric', 'float', 'double', 'real', 'bit', 'bool',
  'boolean', 'char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext',
  'binary', 'varbinary', 'blob', 'tinyblob', 'mediumblob', 'longblob', 'enum',
  'json', 'jsonb', 'date', 'time', 'datetime', 'timestamp', 'timestamptz',
  'year', 'uuid', 'bytea', 'geometry', 'point',
]);

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const OPERATOR_CHARS = '=<>!+-*/%|&^~:';

/** Index just past a quoted run starting at `i` (which holds the opening
 *  quote). Handles doubled-quote escapes (`''`) and, for `'`/`"`, backslash
 *  escapes. An unterminated quote runs to end of input. */
function scanQuoted(src: string, i: number, close: string, backslash: boolean): number {
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (backslash && ch === '\\') { j += 2; continue; }
    if (ch === close) {
      if (src[j + 1] === close && close !== ']') { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return src.length;
}

function scanNumber(src: string, i: number): number {
  let j = i;
  if (src[j] === '0' && /[xX]/.test(src[j + 1] ?? '')) {
    j += 2;
    while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
    return j;
  }
  while (j < src.length && DIGIT.test(src[j])) j++;
  if (src[j] === '.' && DIGIT.test(src[j + 1] ?? '')) {
    j++;
    while (j < src.length && DIGIT.test(src[j])) j++;
  }
  if (/[eE]/.test(src[j] ?? '') && /[0-9+-]/.test(src[j + 1] ?? '')) {
    j += 2;
    while (j < src.length && DIGIT.test(src[j])) j++;
  }
  return j;
}

function push(tokens: Token[], type: TokenType, text: string) {
  // Merge adjacent runs of the same type so the DOM stays small.
  const last = tokens[tokens.length - 1];
  if (last && last.type === type) last.text += text;
  else tokens.push({ type, text });
}

export function tokenizeSql(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // Comments: `-- …`, `# …` (MySQL), `/* … */`.
    if ((ch === '-' && next === '-') || ch === '#') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = src.length;
      push(tokens, 'comment', src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const j = close < 0 ? src.length : close + 2;
      push(tokens, 'comment', src.slice(i, j));
      i = j;
      continue;
    }

    if (ch === "'") {
      const j = scanQuoted(src, i, "'", true);
      push(tokens, 'string', src.slice(i, j));
      i = j;
      continue;
    }
    // Quoted identifiers. Double quotes are identifiers in Postgres and in
    // MySQL's ANSI_QUOTES mode; colouring them as identifiers is the safer
    // reading for both dialects (see stripNoise in sqlContext).
    if (ch === '`' || ch === '"' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      const j = scanQuoted(src, i, close, false);
      push(tokens, 'identifier', src.slice(i, j));
      i = j;
      continue;
    }

    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(next ?? '') && !IDENT_CHAR.test(src[i - 1] ?? ''))) {
      // A leading-dot literal (`.5`) is scanned from its first digit.
      const j = scanNumber(src, ch === '.' ? i + 1 : i);
      push(tokens, 'number', src.slice(i, j));
      i = j;
      continue;
    }

    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && IDENT_CHAR.test(src[j])) j++;
      const word = src.slice(i, j);
      const lower = word.toLowerCase();
      // Anything directly after a `.` is a qualified member (`u.order`), never
      // a keyword, even when it shares a keyword's spelling.
      const qualified = src[i - 1] === '.';
      let k = j;
      while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
      const isCall = src[k] === '(';
      let type: TokenType = 'plain';
      if (!qualified) {
        if (TYPES.has(lower)) type = 'type';
        else if (isCall && !KEYWORDS.has(lower)) type = 'function';
        else if (KEYWORDS.has(lower)) type = 'keyword';
        else if (isCall) type = 'function';
      }
      push(tokens, type, word);
      i = j;
      continue;
    }

    if (OPERATOR_CHARS.includes(ch)) {
      push(tokens, 'operator', ch);
      i++;
      continue;
    }

    push(tokens, 'plain', ch);
    i++;
  }
  return tokens;
}

/** MQL requests are JSON. Keys read as identifiers, string values as strings. */
export function tokenizeJson(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      const j = scanQuoted(src, i, '"', true);
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      push(tokens, src[k] === ':' ? 'identifier' : 'string', src.slice(i, j));
      i = j;
      continue;
    }
    if (DIGIT.test(ch) || (ch === '-' && DIGIT.test(src[i + 1] ?? ''))) {
      const j = scanNumber(src, ch === '-' ? i + 1 : i);
      push(tokens, 'number', src.slice(i, j));
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && IDENT_CHAR.test(src[j])) j++;
      const word = src.slice(i, j);
      push(tokens, word === 'true' || word === 'false' || word === 'null' ? 'keyword' : 'plain', word);
      i = j;
      continue;
    }
    push(tokens, 'plain', ch);
    i++;
  }
  return tokens;
}

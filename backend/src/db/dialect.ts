/**
 * SQLite → PostgreSQL SQL translation.
 *
 * Application SQL stays in the SQLite dialect (the codebase's native
 * dialect since inception); the PostgreSQL driver translates it once at
 * prepare() time. Only constructs that are actually used by this codebase
 * are translated — this is deliberately NOT a general-purpose SQLite
 * compatibility layer, and tests assert every translated form.
 *
 * Translations:
 *   ?                     -> $1..$n          (outside literals/comments)
 *   LIKE / NOT LIKE       -> ILIKE / NOT ILIKE (SQLite LIKE is
 *                           ASCII case-insensitive; ILIKE preserves that
 *                           behaviour on PostgreSQL)
 *   <ident> COLLATE NOCASE -> lower(<ident>)  (ORDER BY case-insensitivity)
 *   BEGIN IMMEDIATE       -> BEGIN            (no such mode in PostgreSQL)
 *   json_extract(x,'$.a') -> (x)::jsonb #>> '{a}'
 *   INSERT OR IGNORE      -> INSERT ... ON CONFLICT DO NOTHING
 *
 * Everything else (upserts with `excluded`, partial indexes, LIMIT/OFFSET,
 * COALESCE, GLOB-free SQL, ISO-8601 TEXT timestamps) is already portable.
 */

type Segment = { text: string; literal: boolean };

/**
 * Split SQL into literal/comment segments and code segments so placeholder
 * counting and keyword rewrites never touch string contents.
 */
function splitSegments(sql: string): Segment[] {
  const out: Segment[] = [];
  let code = '';
  let i = 0;
  const pushCode = () => {
    if (code) {
      out.push({ text: code, literal: false });
      code = '';
    }
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      // string literal or quoted identifier
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2; // escaped quote
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      pushCode();
      out.push({ text: sql.slice(i, j), literal: true });
      i = j;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      pushCode();
      out.push({ text: sql.slice(i, end), literal: true });
      i = end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      pushCode();
      out.push({ text: sql.slice(i, end), literal: true });
      i = end;
      continue;
    }
    code += ch;
    i += 1;
  }
  pushCode();
  return out;
}

/** Rewrite json_extract(col, '$.a.b') -> (col)::jsonb #>> '{a,b}'. */
function rewriteJsonExtract(sql: string): string {
  let out = '';
  let rest = sql;
  for (;;) {
    const idx = rest.search(/json_extract\s*\(/i);
    if (idx < 0) {
      out += rest;
      return out;
    }
    // find the matching close paren of json_extract(
    let depth = 0;
    let j = idx;
    let inStr: string | null = null;
    for (; j < rest.length; j++) {
      const c = rest[j]!;
      if (inStr) {
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === "'" || c === '"') {
        inStr = c;
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    const inner = rest.slice(idx, j);
    const m = /^json_extract\s*\(\s*([^,]+?)\s*,\s*'\$\.([\w.]+)'\s*\)$/i.exec(inner);
    if (!m) {
      // Not a shape we understand: keep as-is and continue after it.
      out += rest.slice(0, idx + 'json_extract'.length);
      rest = rest.slice(idx + 'json_extract'.length);
      continue;
    }
    const path = m[2]!.split('.').join(',');
    out += rest.slice(0, idx) + `(${m[1]})::jsonb #>> '{${path}}'`;
    rest = rest.slice(j);
  }
}

const cache = new Map<string, string>();

/** Translate one SQLite-dialect statement into PostgreSQL dialect. */
export function toPostgres(sql: string): string {
  const hit = cache.get(sql);
  if (hit !== undefined) return hit;

  let work = rewriteJsonExtract(sql);

  // INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING (no conflict target:
  // PostgreSQL allows omitting it, meaning "skip any conflicting row").
  let ignoreInsert = false;
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(work)) {
    ignoreInsert = true;
    work = work.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT');
  }

  // BEGIN IMMEDIATE / BEGIN EXCLUSIVE -> BEGIN (PostgreSQL has no such modes).
  work = work.replace(/\bBEGIN\s+(IMMEDIATE|EXCLUSIVE)\b/gi, 'BEGIN');

  const segments = splitSegments(work);
  let param = 0;
  const translated = segments
    .map((seg) => {
      if (seg.literal) return seg.text;
      let text = seg.text;
      // Case-insensitive LIKE (SQLite LIKE is ASCII case-insensitive).
      text = text.replace(/\bNOT\s+LIKE\b/gi, 'NOT ILIKE');
      text = text.replace(/\bLIKE\b/gi, 'ILIKE');
      // `x COLLATE NOCASE` in ORDER BY/WHERE -> lower(x).
      text = text.replace(/([\w.]+)\s+COLLATE\s+NOCASE\b/gi, 'lower($1)');
      // ? placeholders become $1..$n (literals were split out already).
      text = text.replace(/\?/g, () => `$${(param += 1)}`);
      return text;
    })
    .join('');

  const finalSql = ignoreInsert ? `${translated.replace(/;\s*$/, '')} ON CONFLICT DO NOTHING` : translated;

  cache.set(sql, finalSql);
  return finalSql;
}

/** Test hook: clear the translation cache. */
export function clearDialectCache(): void {
  cache.clear();
}

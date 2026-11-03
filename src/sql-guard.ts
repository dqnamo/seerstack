import { QueryError } from "./errors";

// Defense in depth for agent-written SQL. The Tinybird token can only read the
// events datasource anyway; this rejects anything that isn't a plain read and
// turns common mistakes into errors an agent can act on.

export const MAX_SQL_LENGTH = 100_000;
export const MAX_RESULT_ROWS = 10_000;
const MAX_EXECUTION_SECONDS = 10;
const MAX_MEMORY_BYTES = 1_000_000_000;

const BLOCKED_TABLE_FUNCTIONS = new Set([
  "url",
  "urlcluster",
  "file",
  "filecluster",
  "remote",
  "remotesecure",
  "s3",
  "s3cluster",
  "gcs",
  "azureblobstorage",
  "azureblobstoragecluster",
  "hdfs",
  "hdfscluster",
  "mysql",
  "postgresql",
  "mongodb",
  "redis",
  "sqlite",
  "jdbc",
  "odbc",
  "input",
  "cluster",
  "clusterallreplicas",
  "merge",
  "view",
  "viewifpermitted",
  "dictionary",
  "executable",
  "iceberg",
  "icebergs3",
  "deltalake",
  "hudi",
  "loop",
]);

const invalid = (message: string, hint?: string) => new QueryError(message, hint);

// Replaces string literals and comments with spaces and quoted identifiers
// with a bare-word form, so keyword checks can't be fooled by quoting.
export function stripLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if ((ch === "-" && next === "-") || ch === "#") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw invalid("Unterminated /* comment");
      i = end + 2;
      out += " ";
    } else if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      if (i >= sql.length) throw invalid("Unterminated string literal");
      i++;
      out += " '' ";
    } else if (ch === "$" && /[$a-zA-Z_]/.test(next ?? "")) {
      // ClickHouse heredoc strings: $tag$ ... $tag$
      const tagEnd = sql.indexOf("$", i + 1);
      const tag = tagEnd === -1 ? "" : sql.slice(i, tagEnd + 1);
      if (tag && /^\$[a-zA-Z_0-9]*\$$/.test(tag)) {
        const end = sql.indexOf(tag, tagEnd + 1);
        if (end === -1) throw invalid("Unterminated heredoc string");
        i = end + tag.length;
        out += " '' ";
      } else {
        out += ch;
        i++;
      }
    } else if (ch === '"' || ch === "`") {
      const end = sql.indexOf(ch, i + 1);
      if (end === -1) throw invalid(`Unterminated ${ch} identifier`);
      out += sql.slice(i + 1, end).replace(/[^a-zA-Z0-9_.]/g, "_");
      i = end + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Returns the query trimmed and without trailing semicolons, or throws a
// QueryError with a hint.
export function validateSql(input: string): string {
  if (typeof input !== "string" || !input.trim()) throw invalid("SQL is empty", "Pass a single SELECT statement.");
  if (input.length > MAX_SQL_LENGTH) throw invalid(`SQL is longer than ${MAX_SQL_LENGTH} characters`);

  const sql = input.trim().replace(/;\s*$/, "").trim();
  const bare = stripLiterals(sql);

  if (bare.includes(";")) throw invalid("Only one statement per query", "Run extra statements as separate queries.");
  if (!/^\s*(\(\s*)*(select|with)\b/i.test(bare)) {
    throw invalid("Only SELECT queries are allowed", "Start the query with SELECT or WITH. Seerstack is read-only.");
  }
  if (/\b(system|information_schema)\s*\./i.test(bare)) {
    throw invalid("System tables aren't available", "Query the events table. Call get_schema for columns.");
  }
  if (/\binto\b/i.test(bare)) throw invalid("INTO isn't allowed", "Remove the INTO clause.");
  if (/\bsettings\b/i.test(bare)) {
    throw invalid("SETTINGS can't be overridden", "Remove the SETTINGS clause; limits are fixed (10 s, 10,000 rows).");
  }
  if (/\bformat\b(?!\s*\()/i.test(bare)) {
    throw invalid("FORMAT can't be set", "Remove the FORMAT clause; results are always JSON.");
  }

  for (const match of bare.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
    const name = (match[1] as string).toLowerCase();
    if (BLOCKED_TABLE_FUNCTIONS.has(name)) {
      throw invalid(`The ${match[1]}() table function isn't allowed`, "Query the events table only.");
    }
  }
  return sql;
}

// Caps rows, time and memory by wrapping. Fetching one extra row tells us
// whether the result was truncated.
export function wrapForExecution(sql: string): string {
  return `SELECT * FROM (\n${sql}\n) LIMIT ${MAX_RESULT_ROWS + 1} SETTINGS max_execution_time = ${MAX_EXECUTION_SECONDS}, max_memory_usage = ${MAX_MEMORY_BYTES}`;
}

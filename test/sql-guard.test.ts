import { describe, expect, it } from "vitest";
import { QueryError } from "../src/errors";
import { stripLiterals, validateSql, wrapForExecution } from "../src/sql-guard";

describe("validateSql", () => {
  it("accepts reads and trims trailing semicolons", () => {
    expect(validateSql("SELECT count() FROM events;")).toBe("SELECT count() FROM events");
    expect(validateSql("WITH x AS (SELECT 1) SELECT * FROM x")).toContain("WITH");
    expect(validateSql("SELECT 'drop; insert into' AS s FROM events")).toContain("drop; insert into");
  });

  it.each([
    ["", /empty/],
    ["INSERT INTO events VALUES (1)", /Only SELECT/],
    ["SELECT 1; SELECT 2", /one statement/],
    ["SELECT * FROM system.tables", /System tables/],
    ["SELECT 1 INTO OUTFILE 'x'", /INTO/],
    ["SELECT 1 SETTINGS max_execution_time = 999", /SETTINGS/],
    ["SELECT 1 FORMAT CSV", /FORMAT/],
    ["SELECT * FROM url('http://x', CSV)", /url\(\)/],
    ["SELECT * FROM remote('h', db.t)", /remote\(\)/],
    ["SELECT 'unterminated", /Unterminated/],
  ])("rejects %s", (sql, message) => {
    expect(() => validateSql(sql)).toThrow(QueryError);
    expect(() => validateSql(sql)).toThrow(message);
  });

  it("can't be fooled by comments or quoting", () => {
    expect(() => validateSql("SELECT 1 /* ok */; DROP TABLE events")).toThrow(/one statement/);
    expect(() => validateSql('SELECT * FROM "system".tables')).toThrow(/System tables/);
  });
});

describe("stripLiterals", () => {
  it("blanks strings and comments", () => {
    expect(stripLiterals("SELECT 'a;b' -- c;\n, $x$ d; $x$")).not.toContain(";");
  });
});

it("wraps queries with row and time caps", () => {
  expect(wrapForExecution("SELECT 1")).toMatch(
    /^SELECT \* FROM \(\nSELECT 1\n\) LIMIT 10001 SETTINGS max_execution_time = 10/,
  );
});

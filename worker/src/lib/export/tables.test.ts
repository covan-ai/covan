import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPORTED, EXCLUDED } from "./tables";

/**
 * The list has to stay honest, and the way it rots is silence.
 *
 * A table added next year for a feature nobody remembers writing simply will
 * not be in the archive, and nothing anywhere fails — the export keeps working,
 * keeps looking complete, and quietly leaves that table's rows behind. The
 * person who finds out is somebody restoring a workspace they no longer have.
 *
 * So the schema is the source of truth and this walks it. Adding a table forces
 * a decision: in `EXPORTED` with a scope, or in `EXCLUDED` with a reason
 * somebody could argue with.
 */
const MIGRATIONS = join(process.cwd(), "..", "supabase", "migrations");

function tablesInSchema(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const m of sql.matchAll(/create table (?:if not exists )?public\.([a-z_]+)/g)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe("what the export knows about", () => {
  const schema = tablesInSchema();

  it("found the schema at all", () => {
    // Without this a wrong path would make every assertion below pass on an
    // empty set, which is the failure mode of every test that walks a tree.
    expect(schema.length).toBeGreaterThan(15);
    expect(schema).toContain("workspaces");
  });

  it("has decided about every table in the schema", () => {
    const decided = new Set([...EXPORTED.map((t) => t.table), ...Object.keys(EXCLUDED)]);
    const undecided = schema.filter((t) => !decided.has(t));

    expect(
      undecided,
      "these tables exist and the export neither takes them nor says why not. " +
        "Add each to EXPORTED with a scope, or to EXCLUDED with a reason.",
    ).toEqual([]);
  });

  it("does not claim tables the schema does not have", () => {
    // The other direction: an entry outliving its table is a promise the
    // archive cannot keep, and the read would fail at runtime.
    const stale = [...EXPORTED.map((t) => t.table), ...Object.keys(EXCLUDED)].filter(
      (t) => !schema.includes(t),
    );
    expect(stale).toEqual([]);
  });

  it("takes nothing it also says it excludes", () => {
    const both = EXPORTED.map((t) => t.table).filter((t) => t in EXCLUDED);
    expect(both).toEqual([]);
  });

  it("gives every exclusion a reason worth reading", () => {
    for (const [table, reason] of Object.entries(EXCLUDED)) {
      expect(reason.length, `${table}'s reason is too short to be one`).toBeGreaterThan(40);
    }
  });
});

describe("the order the tables are written in", () => {
  it("never scopes a table by ids it has not collected yet", () => {
    // Also the insert order in workspace.sql, so getting this wrong is both an
    // empty table in the archive and a foreign key violation on restore.
    const seen = new Set<string>();
    for (const spec of EXPORTED) {
      if (spec.scope.kind === "in") {
        expect(
          seen.has(spec.scope.from.table),
          `${spec.table} is scoped by ${spec.scope.from.table}, which comes later`,
        ).toBe(true);
      }
      seen.add(spec.table);
    }
  });

  it("starts at the workspace itself", () => {
    expect(EXPORTED[0].table).toBe("workspaces");
  });

  it("names its columns wherever a select * would be refused", () => {
    // 0023 withheld delivery_channels.secret_ciphertext from `authenticated`,
    // and PostgREST expands `*` to every column — including that one — so the
    // read fails with 42501 for the whole row unless the six are named.
    const channels = EXPORTED.find((t) => t.table === "delivery_channels");
    expect(channels?.columns).toBeDefined();
    expect(channels?.columns).not.toContain("secret_ciphertext");
  });
});

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

  // The scoping assertion above is about the EXPORT half — reading a table by
  // ids collected earlier. This is about the RESTORE half, which fails
  // differently and later: `workspace.sql` is replayed top to bottom inside one
  // transaction, so a row inserted before the row it points at aborts the whole
  // restore with a foreign key violation. Nobody finds that out until they are
  // restoring, which is the worst moment to find anything out.
  //
  // The schema is walked rather than listed, for the reason the tests above
  // walk it: a foreign key added next year to a table somebody reordered is
  // exactly the change that would slip through a hand-maintained list.
  //
  // DEFERRABLE constraints are exempt, and there is currently one:
  // `routines.delivery_channel_id`, which 0012 made deferrable precisely so the
  // channels could be collected through the routines that use them. A
  // constraint checked at commit does not care about insert order, and that is
  // the escape hatch for a genuine cycle — a straight dependency, like
  // `documents.routine_id`, should be ordered instead.
  it("never inserts a row before the row it points at", () => {
    const position = new Map(EXPORTED.map((spec, index) => [spec.table, index]));
    const problems: string[] = [];

    for (const file of readdirSync(MIGRATIONS).sort()) {
      if (!file.endsWith(".sql")) continue;
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");

      // Where each `create table` / `alter table` statement starts, so a
      // reference can be attributed to the table it is declared on.
      const owners: Array<{ at: number; table: string }> = [];
      for (const m of sql.matchAll(
        /(?:create|alter) table (?:if not exists |if exists )?public\.([a-z_]+)/g,
      )) {
        owners.push({ at: m.index ?? 0, table: m[1] });
      }

      for (const m of sql.matchAll(/references public\.([a-z_]+)/g)) {
        const at = m.index ?? 0;
        const owner = [...owners].reverse().find((o) => o.at < at)?.table;
        const target = m[1];
        if (!owner || owner === target) continue;

        const from = position.get(owner);
        const to = position.get(target);
        // Only pairs the archive actually replays. A reference into an excluded
        // table says nothing about insert order because neither row is written.
        if (from === undefined || to === undefined) continue;

        // The rest of this column definition, which is where `deferrable`
        // would be. Bounded by the next comma so a later column's modifiers
        // cannot be read as this one's.
        const rest = sql.slice(m.index ?? 0, (m.index ?? 0) + 400);
        const clause = rest.slice(0, rest.search(/,|\n\)/) + 1 || rest.length);
        if (/deferrable/i.test(clause)) continue;

        if (to > from) {
          problems.push(
            `${owner} (position ${from}) references ${target} (position ${to}), ` +
              `declared in ${file}`,
          );
        }
      }
    }

    expect(
      [...new Set(problems)],
      "a restore replays workspace.sql top to bottom, so a table has to come " +
        "after everything it points at — or its constraint has to be DEFERRABLE",
    ).toEqual([]);
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

/**
 * The columns a table names, kept honest the same way the tables are.
 *
 * A spec with `columns` exports exactly those, so a column added to that table
 * next year is silently left behind — the brittleness that made naming
 * `workspaces`' columns (covan-cloud#304) look like a trade rather than a fix.
 * Walking the migrations turns it back into a question: every column of such a
 * table is in `columns` or in `withheld` with a reason, never neither.
 */
function columnsInSchema(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith(".sql")) continue;
    // Comments stripped, so a sentence that mentions `add column` is not one.
    const sql = readFileSync(join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");

    for (const m of sql.matchAll(
      /create table (?:if not exists )?public\.([a-z_]+) \(([\s\S]*?)\n\);/g,
    )) {
      const columns = new Set<string>();
      for (const line of m[2].split("\n")) {
        const name = line.trim().match(/^([a-z_][a-z0-9_]*)\s/)?.[1];
        if (name && !/^(constraint|primary|unique|foreign|check|exclude)$/.test(name)) {
          columns.add(name);
        }
      }
      tables.set(m[1], columns);
    }

    for (const m of sql.matchAll(
      /alter table (?:if exists )?(?:only )?public\.([a-z_]+)([^;]*);/g,
    )) {
      const columns = tables.get(m[1]);
      if (!columns) continue;
      for (const a of m[2].matchAll(/add column (?:if not exists )?([a-z_]+)/g)) columns.add(a[1]);
      for (const a of m[2].matchAll(/drop column (?:if exists )?([a-z_]+)/g)) columns.delete(a[1]);
      for (const a of m[2].matchAll(/rename column ([a-z_]+) to ([a-z_]+)/g)) {
        columns.delete(a[1]);
        columns.add(a[2]);
      }
    }
  }
  return tables;
}

describe("the columns a table names", () => {
  const schema = columnsInSchema();
  const named = EXPORTED.filter((spec) => spec.columns);

  it("found the columns at all", () => {
    expect(schema.get("workspaces")).toContain("gap_report_enabled");
    expect(named.map((spec) => spec.table)).toContain("workspaces");
  });

  it("has decided about every column of each", () => {
    for (const spec of named) {
      const listed = spec.columns!.split(",").map((c) => c.trim());
      const withheld = Object.keys(spec.withheld ?? {});
      const decided = new Set([...listed, ...withheld]);
      const actual = [...(schema.get(spec.table) ?? [])];

      expect(
        actual.filter((c) => !decided.has(c)).sort(),
        `${spec.table} has columns the export neither takes nor withholds. ` +
          "Add each to `columns`, or to `withheld` with a reason.",
      ).toEqual([]);
      expect(
        [...decided].filter((c) => !actual.includes(c)).sort(),
        `${spec.table} names columns the schema does not have`,
      ).toEqual([]);
      expect(
        listed.filter((c) => withheld.includes(c)),
        `${spec.table} both takes and withholds a column`,
      ).toEqual([]);
    }
  });

  it("gives every withheld column a reason", () => {
    for (const spec of EXPORTED) {
      for (const [column, reason] of Object.entries(spec.withheld ?? {})) {
        expect(
          spec.columns,
          `${spec.table} withholds ${column} without naming columns`,
        ).toBeTruthy();
        expect(reason.length, `${spec.table}.${column}'s reason is too short`).toBeGreaterThan(40);
      }
    }
  });

  it("does not carry the gap report's switch", () => {
    // covan-cloud#304. The opt-outs cannot travel, so neither may the switch
    // they qualify: a restored workspace starts with the report off.
    const workspaces = EXPORTED.find((spec) => spec.table === "workspaces")!;
    expect(workspaces.columns!.split(",")).not.toContain("gap_report_enabled");
    expect(workspaces.withheld).toHaveProperty("gap_report_enabled");
  });
});

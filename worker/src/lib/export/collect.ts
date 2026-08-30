import type { SupabaseClient } from "@supabase/supabase-js";
import { EXPORTED, type TableSpec } from "./tables";

/**
 * Reading a workspace out, through the caller's own client.
 *
 * The service client is not used and must not be: an export is a read like any
 * other, and what belongs in it is what this person could have seen by clicking
 * around. Doing it any other way would make a member's export contain an
 * admin's view, which is a data leak wearing the clothes of a feature.
 */

export type Row = Record<string, unknown>;
export type Collected = Record<string, Row[]>;

/**
 * PostgREST answers at most a thousand rows per request unless the server is
 * configured otherwise, and it does so silently — the thousand-and-first
 * message simply is not there. So every read pages, and every read is ordered,
 * because `range()` over an unordered result can repeat one row and drop
 * another between pages.
 */
const PAGE = 1000;

/**
 * How many ids go into one `in (...)`.
 *
 * supabase-js sends selects as GET, so the id list ends up in the query string,
 * and a workspace with two thousand chat sessions would build a URL past what
 * proxies and CDNs accept — an error that appears only for the largest
 * workspaces, which are exactly the ones whose owners most want an export.
 */
const IN_CHUNK = 100;

export class ExportFailure extends Error {
  constructor(
    readonly table: string,
    readonly reason: unknown,
  ) {
    super(`failed to read ${table} for export`);
    this.name = "ExportFailure";
  }
}

/** Minimal shape of the builder, so this file does not carry the generated types. */
type Builder = {
  order: (c: string, o: { ascending: boolean }) => Builder;
  range: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>;
  eq: (c: string, v: string) => Builder;
  in: (c: string, v: string[]) => Builder;
};

async function readPaged(
  db: SupabaseClient,
  spec: TableSpec,
  narrow: (q: Builder) => Builder,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const query = narrow(db.from(spec.table).select(spec.columns ?? "*") as unknown as Builder);
    const { data, error } = await query
      .order(spec.order, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new ExportFailure(spec.table, error);
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

function distinct(values: unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string"))];
}

/**
 * Every workspace-owned row this caller can see, keyed by table.
 *
 * Tables are read in `EXPORTED` order, which is also foreign-key order, so a
 * table scoped by another's ids always finds them already collected.
 */
export async function collectWorkspace(
  db: SupabaseClient,
  workspaceId: string,
): Promise<Collected> {
  const out: Collected = {};

  for (const spec of EXPORTED) {
    const scope = spec.scope;

    if (scope.kind === "workspace") {
      out[spec.table] = await readPaged(db, spec, (q) => q.eq(scope.column, workspaceId));
      continue;
    }

    const ids = distinct((out[scope.from.table] ?? []).map((r) => r[scope.from.column]));
    if (ids.length === 0) {
      out[spec.table] = [];
      continue;
    }

    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      rows.push(...(await readPaged(db, spec, (q) => q.in(scope.column, chunk))));
    }

    // Sorted again here because each chunk was ordered only within itself. The
    // archive is meant to be diffable, and rows arriving in id-batch order
    // rather than in time order would make two exports of unchanged data
    // disagree for no reason.
    rows.sort((a, b) => String(a[spec.order] ?? "").localeCompare(String(b[spec.order] ?? "")));
    out[spec.table] = rows;
  }

  return out;
}

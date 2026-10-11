import {
  fakeDb,
  type Filter,
  type QueryContext,
  type QueryResult,
  type TableHandlers,
} from "./fake-db";

/**
 * `fakeDb`, with tables that hold rows and apply the filters a query carried.
 *
 * `fakeDb` answers whatever a handler returns, which is right for a route that
 * reads one row. It is not enough for a conditional write: the browser task's
 * settle is correct only because `update … where status in ('queued',
 * 'running') returning` hands a row to exactly ONE of two racing callers, and
 * a double that answered both alike would let the module drop the condition
 * and still pass. So the tables here are arrays, an update changes the rows it
 * matches and answers only those, and a filter kind this does not model throws
 * rather than matching everything.
 *
 * Single-threaded JavaScript makes each query atomic, which is what Postgres
 * makes a single UPDATE: two callers awaiting the same conditional update in
 * `Promise.all` are served one after the other, and the second finds the row
 * already changed.
 */

export type Row = Record<string, unknown>;

export function matchesFilters(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    switch (f.kind) {
      case "eq":
        return row[f.column] === f.value;
      case "neq":
        return row[f.column] !== f.value;
      case "is":
        return (row[f.column] ?? null) === f.value;
      case "in":
        return (f.value as unknown[]).includes(row[f.column]);
      default:
        throw new Error(`memoryDb: unmodelled filter ${f.kind} on ${f.column}`);
    }
  });
}

function ordered(rows: Row[], ctx: QueryContext): Row[] {
  const out = [...rows];
  for (const { column, ascending } of [...(ctx.order ?? [])].reverse()) {
    out.sort((a, b) => {
      const x = String(a[column] ?? "");
      const y = String(b[column] ?? "");
      return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
    });
  }
  return ctx.limit === undefined ? out : out.slice(0, ctx.limit);
}

function answer(rows: Row[], ctx: QueryContext): QueryResult {
  const copies = rows.map((r) => ({ ...r }));
  return { data: ctx.single ? (copies[0] ?? null) : copies, error: null };
}

/**
 * @param seed the starting rows, by table. Copied, so a test's fixtures are
 *   never mutated underneath it.
 * @param intercept answers a query instead of the tables when it returns a
 *   result — how a test makes one read or write fail.
 */
export function memoryDb(
  seed: Record<string, Row[]>,
  intercept?: (ctx: QueryContext) => QueryResult | undefined,
) {
  const tables: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([name, rows]) => [name, rows.map((r) => ({ ...r }))]),
  );
  const handlers: Record<string, TableHandlers> = {};
  for (const name of Object.keys(tables)) {
    handlers[name] = {
      select: (ctx) =>
        intercept?.(ctx) ??
        answer(
          ordered(
            tables[name].filter((r) => matchesFilters(r, ctx.filters)),
            ctx,
          ),
          ctx,
        ),
      update: (ctx) => {
        const stopped = intercept?.(ctx);
        if (stopped) return stopped;
        const hit = tables[name].filter((r) => matchesFilters(r, ctx.filters));
        for (const r of hit) Object.assign(r, ctx.values);
        return answer(hit, ctx);
      },
      insert: (ctx) => {
        const stopped = intercept?.(ctx);
        if (stopped) return stopped;
        // `id uuid primary key default gen_random_uuid()`, as every table here
        // has: an insert that names no id still gets one back, which is what
        // a claim-first writer (`ensureProfile`) keys its fill to.
        const row = { id: `${name}-${tables[name].length + 1}`, ...ctx.values };
        tables[name].push(row);
        return answer([row], ctx);
      },
      delete: (ctx) => {
        const stopped = intercept?.(ctx);
        if (stopped) return stopped;
        const hit = tables[name].filter((r) => matchesFilters(r, ctx.filters));
        for (const r of hit) tables[name].splice(tables[name].indexOf(r), 1);
        return answer(hit, ctx);
      },
    };
  }
  return { ...fakeDb({ tables: handlers }), tables };
}

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
      case "or":
        return matchesOr(row, String(f.value));
      default:
        throw new Error(`memoryDb: unmodelled filter ${f.kind} on ${f.column}`);
    }
  });
}

/** Split on the commas that are not inside a `(…)` list. */
function topLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    if (expr[i] === "(") depth += 1;
    else if (expr[i] === ")") depth -= 1;
    else if (expr[i] === "," && depth === 0) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

/**
 * PostgREST's `or=(…)` as supabase-js sends it — `col.op.value,…`, any one
 * of which may be negated as `col.not.op.value` — for the operators in use:
 * `eq`, `neq`, `is` (`null`, `true`, `false`) and `in.(a,b)`. Values arrive
 * as text, as they do over the wire, so a column is compared as text too.
 * Anything else throws, for the reason the file's header gives.
 */
export function matchesOr(row: Row, expr: string): boolean {
  return topLevel(expr).some((condition) => {
    const [column, ...rest] = condition.split(".");
    const negated = rest[0] === "not";
    const [op, ...valueParts] = negated ? rest.slice(1) : rest;
    const value = valueParts.join(".");
    const cell = row[column] ?? null;
    let hit: boolean;
    switch (op) {
      case "is":
        if (value === "null") hit = cell === null;
        else if (value === "true" || value === "false") hit = cell === (value === "true");
        else throw new Error(`memoryDb: unmodelled is.${value} in or(${expr})`);
        return negated ? !hit : hit;
      case "eq":
        hit = String(cell) === value;
        break;
      case "neq":
        hit = String(cell) !== value;
        break;
      case "in": {
        if (!value.startsWith("(") || !value.endsWith(")")) {
          throw new Error(`memoryDb: malformed in-list in or(${expr})`);
        }
        hit = value.slice(1, -1).split(",").includes(String(cell));
        break;
      }
      default:
        throw new Error(`memoryDb: unmodelled operator ${op} in or(${expr})`);
    }
    // SQL's three values: a comparison with NULL is unknown, and so is its
    // negation — only `is` says anything about a NULL.
    if (cell === null) return false;
    return negated ? !hit : hit;
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

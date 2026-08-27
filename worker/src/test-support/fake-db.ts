/**
 * A stand-in for the request-scoped Supabase client that routes read off
 * `c.get("db")`.
 *
 * The existing route tests each hand-roll their own fake, which is the right
 * call when a route touches one table in one way. The workspace and invitation
 * routes do not: between them they select, insert, update, delete and call RPCs
 * across four tables, and `getActiveWorkspaceId` adds two more queries in front
 * of almost every handler. Three more hand-rolled builders would be three more
 * chances to write a fake that quietly accepts a query the real client would
 * reject.
 *
 * So this one is deliberately strict. It models only the chain shapes the
 * routes actually use, and throws — loudly, naming the table — on anything
 * else. A route that starts issuing a different query fails here rather than
 * passing against a fake that shrugged.
 *
 * What it does NOT do is enforce RLS. It cannot: RLS lives in Postgres. These
 * tests check that a route reacts correctly to what the database tells it
 * (0 rows means forbidden, an error code means conflict). Whether the database
 * says the right thing is what tests/rls/ is for.
 */

export type QueryResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

export type Filter = { column: string; value: unknown; kind: "eq" | "in" | "gt" | "ilike" };

export type QueryContext = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  /** Columns passed to `.select(...)`, if any. */
  columns?: string;
  /** Payload passed to `.insert(...)` or `.update(...)`. */
  values?: Record<string, unknown>;
  filters: Filter[];
  /** True when the caller ended the chain with `.single()`/`.maybeSingle()`. */
  single: boolean;
};

export type Handler = (ctx: QueryContext) => QueryResult | Promise<QueryResult>;

export type TableHandlers = Partial<Record<QueryContext["op"], Handler>>;

export type FakeDbSpec = {
  tables?: Record<string, TableHandlers>;
  rpc?: Record<string, (args: Record<string, unknown>) => QueryResult | Promise<QueryResult>>;
  /**
   * Email/workspace pairs standing in for existing `profiles` +
   * `workspace_members` rows, for the two-step "is this person already a
   * member" lookup in POST /invitations: a `profiles` select filtered by
   * `ilike("email", ...)`, followed by a `workspace_members` select filtered
   * by the resolved user id AND the queried workspace_id.
   *
   * The workspace_id matters: a fixture entry only answers a
   * `workspace_members` query whose `workspace_id` filter equals that entry's
   * `workspaceId`, so a test can assert that a match in one workspace does
   * NOT block an invite scoped to another — that's what proves the route
   * scopes to the caller's active workspace rather than any workspace the
   * address happens to belong to.
   *
   * This intercepts those two specific query shapes ahead of the ordinary
   * per-table handlers (including the ones `activeWorkspaceTables` installs
   * for `getActiveWorkspaceId`'s unrelated queries against the same two
   * tables), so it never has to know what handlers a test also registered for
   * those tables.
   */
  existingMemberEmails?: Array<{ email: string; workspaceId: string }>;
};

/** Every query the fake served, in order. Useful for asserting what was sent. */
export type Recorded = QueryContext & { result: QueryResult };

/**
 * Thenable so `await db.from(...).select(...).eq(...)` works, with `single()`
 * and `maybeSingle()` as the alternative terminators — exactly the two shapes
 * supabase-js offers.
 */
class Chain implements PromiseLike<QueryResult> {
  constructor(
    private readonly ctx: QueryContext,
    private readonly run: (ctx: QueryContext) => Promise<QueryResult>,
  ) {}

  select(columns?: string) {
    this.ctx.columns = columns;
    return this;
  }

  eq(column: string, value: unknown) {
    this.ctx.filters.push({ column, value, kind: "eq" });
    return this;
  }

  in(column: string, value: unknown) {
    this.ctx.filters.push({ column, value, kind: "in" });
    return this;
  }

  gt(column: string, value: unknown) {
    this.ctx.filters.push({ column, value, kind: "gt" });
    return this;
  }

  ilike(column: string, value: unknown) {
    this.ctx.filters.push({ column, value, kind: "ilike" });
    return this;
  }

  // Ordering and limiting change which rows come back, not whether the route is
  // allowed to see them. Handlers return a fixed set, so these are no-ops that
  // exist only so the chain does not break.
  order() {
    return this;
  }

  limit() {
    return this;
  }

  maybeSingle(): Promise<QueryResult> {
    this.ctx.single = true;
    return this.run(this.ctx);
  }

  single(): Promise<QueryResult> {
    this.ctx.single = true;
    return this.run(this.ctx);
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run(this.ctx).then(onfulfilled, onrejected);
  }
}

export function fakeDb(spec: FakeDbSpec) {
  const calls: Recorded[] = [];

  const MEMBER_ID_PREFIX = "member-id:";
  // The email survives round-trip inside the synthetic id (rather than an
  // opaque counter) so the workspace_members step below can look the fixture
  // entry back up by email without a second map.
  const memberIdForEmail = (email: string) => `${MEMBER_ID_PREFIX}${email.toLowerCase()}`;

  const run = async (ctx: QueryContext): Promise<QueryResult> => {
    if (spec.existingMemberEmails) {
      const emailFilter = ctx.filters.find((f) => f.kind === "ilike" && f.column === "email");
      if (ctx.table === "profiles" && ctx.op === "select" && emailFilter) {
        // The route escapes ILIKE metacharacters before sending the pattern;
        // undo that here so the fixture matches on the plain address, the way
        // Postgres would after applying the ESCAPE clause.
        const email = String(emailFilter.value)
          .replace(/\\([%_])/g, "$1")
          .toLowerCase();
        const isMember = spec.existingMemberEmails.some((m) => m.email.toLowerCase() === email);
        const result: QueryResult = {
          data: isMember ? { id: memberIdForEmail(email) } : null,
          error: null,
        };
        calls.push({ ...ctx, result });
        return result;
      }

      const memberIdFilter = ctx.filters.find(
        (f) =>
          f.kind === "eq" &&
          f.column === "user_id" &&
          typeof f.value === "string" &&
          f.value.startsWith(MEMBER_ID_PREFIX),
      );
      if (ctx.table === "workspace_members" && ctx.op === "select" && memberIdFilter) {
        const email = String(memberIdFilter.value).slice(MEMBER_ID_PREFIX.length);
        const workspaceFilter = ctx.filters.find(
          (f) => f.kind === "eq" && f.column === "workspace_id",
        );
        // A fixture entry only answers for the workspace it names — a match
        // recorded against some other workspace must not satisfy a query
        // scoped to this one.
        const match = spec.existingMemberEmails.find(
          (m) => m.email.toLowerCase() === email && m.workspaceId === workspaceFilter?.value,
        );
        const result: QueryResult = {
          data: match ? { user_id: memberIdFilter.value } : null,
          error: null,
        };
        calls.push({ ...ctx, result });
        return result;
      }
    }

    const handlers = spec.tables?.[ctx.table];
    if (!handlers) {
      throw new Error(`fakeDb: unexpected table "${ctx.table}"`);
    }
    const handler = handlers[ctx.op];
    if (!handler) {
      throw new Error(`fakeDb: unexpected ${ctx.op} on "${ctx.table}"`);
    }
    const result = await handler(ctx);
    calls.push({ ...ctx, result });
    return result;
  };

  const start = (table: string, op: QueryContext["op"], values?: Record<string, unknown>) =>
    new Chain({ table, op, values, filters: [], single: false }, run);

  const db = {
    from(table: string) {
      return {
        select: (columns?: string) => start(table, "select").select(columns),
        insert: (values: Record<string, unknown>) => start(table, "insert", values),
        update: (values: Record<string, unknown>) => start(table, "update", values),
        delete: () => start(table, "delete"),
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      const handler = spec.rpc?.[name];
      if (!handler) {
        throw new Error(`fakeDb: unexpected rpc "${name}"`);
      }
      return handler(args);
    },
  };

  return {
    db,
    calls,
    /** The queries sent to one table, oldest first. */
    callsTo: (table: string) => calls.filter((c) => c.table === table),
  };
}

/** The two rows `getActiveWorkspaceId` needs to resolve a workspace cleanly. */
export function activeWorkspaceTables(userId: string, workspaceId: string) {
  return {
    profiles: {
      select: () => ({ data: { active_workspace_id: workspaceId }, error: null }),
      update: () => ({ data: null, error: null }),
    },
    workspace_members: {
      select: (ctx: QueryContext) => {
        const forUser = ctx.filters.some((f) => f.column === "user_id" && f.value === userId);
        const forWorkspace = ctx.filters.some(
          (f) => f.column === "workspace_id" && f.value === workspaceId,
        );
        if (forUser && forWorkspace) {
          return { data: { workspace_id: workspaceId }, error: null };
        }
        return { data: null, error: null };
      },
    },
  } satisfies Record<string, TableHandlers>;
}

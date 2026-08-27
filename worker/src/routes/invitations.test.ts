import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { invitations } from "./invitations";
import {
  activeWorkspaceTables,
  fakeDb,
  type FakeDbSpec,
  type QueryContext,
} from "../test-support/fake-db";

/**
 * Invitations are how someone who is not in a workspace gets into it, which
 * makes this the one route file where a mistake hands out access rather than
 * merely leaking a read.
 *
 * The route itself is thin on purpose: the database decides who may invite
 * (the `invitations_insert_admin` policy) and who may accept (the
 * `accept_invitation` SECURITY DEFINER function). What these tests hold in
 * place is the layer above that — that the route asks on behalf of the caller
 * and nobody else, and that when the database declines, the route says so
 * instead of reporting success.
 */

const USER = { id: "user-1", email: "admin@example.com" };
const WORKSPACE = "ws-1";
const CREATED_AT = "2026-08-01T09:00:00.000Z";

/** `user` overrides the caller — only the incoming-invitations case needs it,
    to check an address whose capitals survived signup. */
function appWith(spec: FakeDbSpec & { user?: { id: string; email: string } }) {
  const { user = USER, ...dbSpec } = spec;
  const fake = fakeDb({
    ...dbSpec,
    tables: { ...activeWorkspaceTables(user.id, WORKSPACE), ...dbSpec.tables },
  });

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", user as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", invitations);

  return { app, ...fake };
}

const json = (
  app: Hono<AppEnv>,
  method: string,
  path: string,
  body?: unknown,
  env?: Record<string, string>,
) =>
  app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    // Hono's third argument is the Bindings object. Left undefined for every
    // test that does not care, which is also what a deployment with no mail
    // configured looks like from inside the handler.
    env,
  );

const MAIL_ENV = {
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Covan <hello@covan.test>",
  ALLOWED_ORIGIN: "https://covan.test",
};

describe("GET /invitations", () => {
  it("lists the pending invitations of the caller's own workspace", async () => {
    const { app, callsTo } = appWith({
      tables: {
        invitations: {
          select: () => ({
            data: [
              { id: "inv-1", email: "new@example.com", role: "member", created_at: CREATED_AT },
            ],
            error: null,
          }),
        },
      },
    });

    const res = await json(app, "GET", "/invitations");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      {
        id: "inv-1",
        email: "new@example.com",
        role: "member",
        createdAt: Date.parse(CREATED_AT),
      },
    ]);

    // The filters are the whole point: without the workspace_id filter an admin
    // of one workspace would page through every pending invite RLS lets them see.
    expect(callsTo("invitations")[0].filters).toEqual([
      { column: "workspace_id", value: WORKSPACE, kind: "eq" },
      { column: "status", value: "pending", kind: "eq" },
      { column: "expires_at", value: expect.any(String), kind: "gt" },
    ]);
  });

  it("excludes invitations past their expiry from the pending list", async () => {
    // status = 'pending' alone is not enough once invitations expire: 0029
    // backfilled expires_at onto every pre-existing pending row rather than
    // voiding it, so an old, unexpired-looking row is exactly the case this
    // filter has to catch going forward.
    const { app, callsTo } = appWith({
      tables: {
        invitations: { select: () => ({ data: [], error: null }) },
      },
    });

    await json(app, "GET", "/invitations");

    expect(callsTo("invitations")[0].filters).toContainEqual({
      column: "expires_at",
      value: expect.any(String),
      kind: "gt",
    });
  });

  it("answers 404 when the caller has no workspace at all", async () => {
    const { app } = appWith({
      tables: {
        profiles: { select: () => ({ data: { active_workspace_id: null }, error: null }) },
        workspace_members: { select: () => ({ data: null, error: null }) },
      },
    });

    const res = await json(app, "GET", "/invitations");

    expect(res.status).toBe(404);
  });

  it("does not pass a database failure off as an empty list", async () => {
    const { app } = appWith({
      tables: {
        invitations: { select: () => ({ data: null, error: { message: "boom" } }) },
      },
    });

    expect((await json(app, "GET", "/invitations")).status).toBe(500);
  });
});

describe("POST /invitations", () => {
  const created = {
    id: "inv-1",
    email: "new@example.com",
    role: "member",
    created_at: CREATED_AT,
  };

  it("records the invite against the caller's workspace and name", async () => {
    let inserted: Record<string, unknown> | undefined;
    const { app } = appWith({
      tables: {
        invitations: {
          insert: (ctx: QueryContext) => {
            inserted = ctx.values;
            return { data: [created], error: null };
          },
        },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "new@example.com",
      role: "member",
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({
      id: "inv-1",
      email: "new@example.com",
      role: "member",
      createdAt: Date.parse(CREATED_AT),
      // No RESEND_API_KEY in these tests, which is also a real deployment: mail
      // is optional and the invitation stands without it. The dialog reads this
      // to say what happened rather than claiming an email went out.
      emailed: false,
    });

    // workspace_id comes from the caller's session, never from the request
    // body, and invited_by is stamped server-side.
    expect(inserted).toEqual({
      workspace_id: WORKSPACE,
      email: "new@example.com",
      role: "member",
      invited_by: USER.id,
    });
  });

  it("lowercases the address so the same person cannot be invited twice", async () => {
    let inserted: Record<string, unknown> | undefined;
    const { app } = appWith({
      tables: {
        invitations: {
          insert: (ctx: QueryContext) => {
            inserted = ctx.values;
            return { data: [created], error: null };
          },
        },
      },
    });

    await json(app, "POST", "/invitations", { email: "NEW@Example.COM", role: "member" });

    expect(inserted?.email).toBe("new@example.com");
  });

  it("trims an address rather than calling it malformed", async () => {
    // This used to answer 400: the handler trimmed, but only after
    // `z.string().email()` had already rejected the padding. Someone pasting an
    // address with a trailing space was told their email was invalid.
    let inserted: Record<string, unknown> | undefined;
    const { app } = appWith({
      tables: {
        invitations: {
          insert: (ctx: QueryContext) => {
            inserted = ctx.values;
            return { data: [created], error: null };
          },
        },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "  New@Example.com  ",
      role: "member",
    });

    expect(res.status).toBe(201);
    expect(inserted?.email).toBe("new@example.com");
  });

  it.each([
    ["a malformed address", { email: "not-an-email", role: "member" }],
    ["a role that does not exist", { email: "new@example.com", role: "owner" }],
    ["a missing role", { email: "new@example.com" }],
    ["nothing at all", {}],
  ])("rejects %s without touching the table", async (_label, body) => {
    // No `invitations` handler is registered, so any query would throw.
    const { app } = appWith({});

    expect((await json(app, "POST", "/invitations", body)).status).toBe(400);
  });

  it("409s rather than inviting somebody who is already in the workspace", async () => {
    const { app } = appWith({
      existingMemberEmails: [{ email: "bob@corp.com", workspaceId: WORKSPACE }],
      tables: {
        invitations: {
          insert: () => ({
            data: [{ ...created, email: "bob@corp.com" }],
            error: null,
          }),
        },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "bob@corp.com",
      role: "member",
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "they're already in this workspace" });
  });

  it("does not block an invite to someone who belongs to a different workspace", async () => {
    // Proves the check is scoped to the caller's active workspace (WORKSPACE)
    // rather than "any workspace this address happens to be a member of": if
    // the production `.eq("workspace_id", workspaceId)` were dropped, or
    // pointed at the wrong workspace, this would 409 instead of succeeding.
    const { app } = appWith({
      existingMemberEmails: [{ email: "carol@corp.com", workspaceId: "ws-2" }],
      tables: {
        invitations: {
          insert: () => ({
            data: [{ ...created, email: "carol@corp.com" }],
            error: null,
          }),
        },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "carol@corp.com",
      role: "member",
    });

    expect(res.status).toBe(201);
  });

  it("escapes ILIKE wildcards in the address before the membership lookup", async () => {
    // '_' is a valid character in a real local part (bob_smith@corp.com) but
    // an ILIKE single-character wildcard when unescaped — a stray wildcard in
    // a lookup built from user input is exactly what this route should never
    // send. Asserting on the recorded filter (rather than on a fake that
    // understands ILIKE semantics) is deliberate: the fake stays a strict
    // recorder of what was sent, not a second implementation of Postgres.
    const { app, callsTo } = appWith({
      tables: {
        invitations: {
          insert: () => ({ data: [{ ...created, email: "bob_smith@corp.com" }], error: null }),
        },
      },
    });

    await json(app, "POST", "/invitations", { email: "bob_smith@corp.com", role: "member" });

    const profileLookup = callsTo("profiles").find((c) =>
      c.filters.some((f) => f.kind === "ilike"),
    );
    expect(profileLookup?.filters).toContainEqual({
      column: "email",
      value: "bob\\_smith@corp.com",
      kind: "ilike",
    });
  });

  it("reports a duplicate as a conflict, not a failure", async () => {
    const { app } = appWith({
      tables: {
        invitations: {
          insert: () => ({ data: null, error: { message: "duplicate key", code: "23505" } }),
        },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "new@example.com",
      role: "member",
    });

    expect(res.status).toBe(409);
  });

  it("treats an RLS refusal as forbidden", async () => {
    // A non-admin's insert fails the policy's WITH CHECK and comes back as an
    // error. 403 is the honest answer.
    const { app } = appWith({
      tables: {
        invitations: {
          insert: () => ({ data: null, error: { message: "new row violates row-level security" } }),
        },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "new@example.com",
      role: "member",
    });

    expect(res.status).toBe(403);
  });

  it("treats a silent zero-row insert as forbidden too", async () => {
    // The failure mode that would otherwise look like success: no error, no
    // row. Answering 201 here would show the inviter a member who was never
    // invited.
    const { app } = appWith({
      tables: {
        invitations: { insert: () => ({ data: [], error: null }) },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "new@example.com",
      role: "member",
    });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /invitations/:id", () => {
  it("revokes an invitation the caller is allowed to revoke", async () => {
    const { app, callsTo } = appWith({
      tables: {
        invitations: { delete: () => ({ data: [{ id: "inv-1" }], error: null }) },
      },
    });

    const res = await json(app, "DELETE", "/invitations/inv-1");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(callsTo("invitations")[0].filters).toEqual([
      { column: "id", value: "inv-1", kind: "eq" },
    ]);
  });

  it("answers 404 when RLS matched nothing", async () => {
    // Deleting someone else's invitation matches zero rows. The route must not
    // report `{ ok: true }` for work it did not do.
    const { app } = appWith({
      tables: {
        invitations: { delete: () => ({ data: [], error: null }) },
      },
    });

    const res = await json(app, "DELETE", "/invitations/someone-elses");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "invitation not found or not permitted",
    });
  });
});

describe("GET /invitations/incoming", () => {
  it("names the workspace whether PostgREST embeds it as an object or an array", async () => {
    for (const embedded of [{ name: "Acme" }, [{ name: "Acme" }]]) {
      const { app } = appWith({
        tables: {
          invitations: {
            select: () => ({
              data: [
                {
                  id: "inv-1",
                  workspace_id: "ws-2",
                  role: "member",
                  created_at: CREATED_AT,
                  workspaces: embedded,
                },
              ],
              error: null,
            }),
          },
        },
      });

      const res = await json(app, "GET", "/invitations/incoming");

      await expect(res.json()).resolves.toEqual([
        {
          id: "inv-1",
          workspaceId: "ws-2",
          workspaceName: "Acme",
          role: "member",
          createdAt: Date.parse(CREATED_AT),
        },
      ]);
    }
  });

  it("survives an invitation whose workspace did not come back", async () => {
    const { app } = appWith({
      tables: {
        invitations: {
          select: () => ({
            data: [
              {
                id: "inv-1",
                workspace_id: "ws-2",
                role: "member",
                created_at: CREATED_AT,
                workspaces: null,
              },
            ],
            error: null,
          }),
        },
      },
    });

    const res = await json(app, "GET", "/invitations/incoming");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([expect.objectContaining({ workspaceName: "" })]);
  });

  /**
   * The route used to lean entirely on `invitations_select_admin_or_invitee`,
   * which admits a row when the caller is an admin of the workspace OR the row
   * is addressed to them. So it answered "invitations you can see" to a
   * question that asked "invitations addressed to you", and an admin met their
   * own outgoing invitations in the incoming banner — "You've been invited to
   * <your own workspace> as <the role you just granted somebody else>", with an
   * Accept button `accept_invitation()` was always going to refuse.
   *
   * Asserted on the filter rather than on the rows, because the fake client
   * cannot enforce a policy: a test that only checked the response would pass
   * with the filter deleted.
   */
  it("asks only for invitations addressed to the caller, not every one they may read", async () => {
    let filters: { column: string; value: unknown }[] = [];
    const { app } = appWith({
      tables: {
        invitations: {
          select: (ctx) => {
            filters = ctx.filters as typeof filters;
            return { data: [], error: null };
          },
        },
      },
    });

    await json(app, "GET", "/invitations/incoming");

    expect(filters).toContainEqual(expect.objectContaining({ column: "email", value: USER.email }));
  });

  it("lowercases the caller's own address, since the stored one always is", async () => {
    let filters: { column: string; value: unknown }[] = [];
    const { app } = appWith({
      user: { id: USER.id, email: "Admin@Example.com" },
      tables: {
        invitations: {
          select: (ctx) => {
            filters = ctx.filters as typeof filters;
            return { data: [], error: null };
          },
        },
      },
    });

    await json(app, "GET", "/invitations/incoming");

    // POST /invitations lowercases on the way in, so a caller whose auth record
    // kept its capitals would otherwise match none of their own invitations.
    expect(filters).toContainEqual(
      expect.objectContaining({ column: "email", value: "admin@example.com" }),
    );
  });
});

describe("POST /invitations/:id/accept", () => {
  it("hands the id to the database function and returns the workspace joined", async () => {
    let args: Record<string, unknown> | undefined;
    const { app } = appWith({
      rpc: {
        accept_invitation: (received) => {
          args = received;
          return { data: "ws-2", error: null };
        },
      },
    });

    const res = await json(app, "POST", "/invitations/inv-1/accept");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workspaceId: "ws-2" });
    // The caller is never named here: `accept_invitation` reads auth.uid()
    // itself, so there is no id for a caller to substitute.
    expect(args).toEqual({ p_invite_id: "inv-1" });
  });

  it("refuses when the database function refuses", async () => {
    // Accepting an invitation addressed to somebody else raises inside the
    // function. The message is what the user sees.
    const { app } = appWith({
      rpc: {
        accept_invitation: () => ({
          data: null,
          error: { message: "invitation is not addressed to you" },
        }),
      },
    });

    const res = await json(app, "POST", "/invitations/someone-elses/accept");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "invitation is not addressed to you",
    });
  });
});

describe("POST /invitations — telling the invitee", () => {
  /**
   * The gap this closes was not a missing feature so much as a false sentence:
   * the dialog said "Invite sent" and nothing had ever been sent. So what these
   * tests hold in place is that `emailed` reports what actually happened, in
   * every direction — including the two where it is false and the invitation
   * still stands.
   */
  const created = {
    id: "inv-1",
    email: "new@example.com",
    role: "member",
    created_at: CREATED_AT,
  };

  function appWithMail(fetchImpl: typeof fetch) {
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    return appWith({
      tables: {
        invitations: { insert: () => ({ data: [created], error: null }) },
        workspaces: { select: () => ({ data: { name: "Acme" }, error: null }) },
        profiles: {
          select: (ctx: QueryContext) =>
            ctx.columns === "name"
              ? { data: { name: "Ada Lovelace" }, error: null }
              : { data: { active_workspace_id: WORKSPACE }, error: null },
        },
      },
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emails the invitee, naming the inviter and the workspace", async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const { app } = appWithMail(async (input, init) => {
      sent = { url: String(input), body: JSON.parse(String(init?.body)) };
      return new Response("{}", { status: 200 });
    });

    const res = await json(
      app,
      "POST",
      "/invitations",
      { email: "new@example.com", role: "member" },
      MAIL_ENV,
    );

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ emailed: true });

    expect(sent?.url).toBe("https://api.resend.com/emails");
    expect(sent?.body.from).toBe(MAIL_ENV.RESEND_FROM);
    expect(sent?.body.to).toEqual(["new@example.com"]);
    expect(sent?.body.subject).toBe("Ada Lovelace invited you to Acme on Covan");

    const text = String(sent?.body.text);
    // The address is the credential — accept_invitation matches it against the
    // caller's verified JWT email — so the mail has to name which address to
    // sign in with, and must not offer a link that accepts on its own.
    expect(text).toContain("new@example.com");
    expect(text).toContain(MAIL_ENV.ALLOWED_ORIGIN);
    expect(text, "the mail offered a link that accepts the invitation").not.toMatch(
      /\/invitations?\/[\w-]+\/accept|token=/,
    );
  });

  it("still creates the invitation when Resend refuses", async () => {
    const { app } = appWithMail(async () => new Response("nope", { status: 422 }));

    const res = await json(
      app,
      "POST",
      "/invitations",
      { email: "new@example.com", role: "member" },
      MAIL_ENV,
    );

    // The row is the invitation. /invitations/incoming will still find it and
    // accept_invitation will still consume it, so a failed courtesy email must
    // not turn into a failed request.
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ id: "inv-1", emailed: false });
  });

  it("does not try, and does not claim to have tried, without a mail sender", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const { app } = appWithMail(fetchImpl as unknown as typeof fetch);

    const res = await json(app, "POST", "/invitations", {
      email: "new@example.com",
      role: "member",
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ emailed: false });
    expect(fetchImpl, "posted to Resend with no API key").not.toHaveBeenCalled();
  });
});

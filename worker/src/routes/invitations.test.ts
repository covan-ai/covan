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
    to check an address whose capitals survived signup. `apiKeyId` pretends the
    caller arrived with a key rather than a session. */
function appWith(spec: FakeDbSpec & { user?: { id: string; email: string }; apiKeyId?: string }) {
  const { user = USER, apiKeyId, ...dbSpec } = spec;
  const fake = fakeDb({
    ...dbSpec,
    tables: {
      ...activeWorkspaceTables(user.id, WORKSPACE),
      // Today's invitations so far, for the daily cap. None, unless a test says.
      workspace_events: { select: () => ({ data: null, error: null, count: 0 }) },
      ...dbSpec.tables,
    },
  });

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", user as never);
    c.set("db", fake.db as never);
    if (apiKeyId) c.set("apiKeyId", apiKeyId);
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
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { app, callsTo } = appWith({
      tables: {
        invitations: {
          select: () => ({
            data: [
              {
                id: "inv-1",
                email: "new@example.com",
                role: "member",
                created_at: CREATED_AT,
                expires_at: future,
                token_issued_at: CREATED_AT,
              },
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
        needsResend: false,
      },
    ]);

    // The filters are the whole point: without the workspace_id filter an admin
    // of one workspace would page through every pending invite RLS lets them see.
    expect(callsTo("invitations")[0].filters).toEqual([
      { column: "workspace_id", value: WORKSPACE, kind: "eq" },
      { column: "status", value: "pending", kind: "eq" },
    ]);
  });

  it("keeps an expired or link-less invitation, marked for a new link", async () => {
    // Since 0090 an invitation needs its emailed token to be accepted. One whose
    // seven days ran out, or one made before tokens existed, is still somebody
    // the admin meant to invite: listed with a Resend rather than dropped.
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const { app } = appWith({
      tables: {
        invitations: {
          select: () => ({
            data: [
              {
                id: "expired",
                email: "a@example.com",
                role: "member",
                created_at: CREATED_AT,
                expires_at: past,
                token_issued_at: CREATED_AT,
              },
              {
                id: "no-link",
                email: "b@example.com",
                role: "member",
                created_at: CREATED_AT,
                expires_at: future,
                token_issued_at: null,
              },
            ],
            error: null,
          }),
        },
      },
    });

    const body = (await (await json(app, "GET", "/invitations")).json()) as Array<{
      id: string;
      needsResend: boolean;
    }>;
    expect(body.map((i) => [i.id, i.needsResend])).toEqual([
      ["expired", true],
      ["no-link", true],
    ]);
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: "inv-1",
      email: "new@example.com",
      role: "member",
      createdAt: Date.parse(CREATED_AT),
      // No RESEND_API_KEY in these tests, which is also a real deployment: mail
      // is optional and the invitation stands without it. The dialog reads this
      // to say what happened rather than claiming an email went out.
      emailed: false,
      // The only time the link exists outside the email. With no mail, it is
      // how the admin gets it to the invitee.
      inviteUrl: expect.stringMatching(/\/invite#id=inv-1&token=[A-Za-z0-9_-]{43}$/),
      needsResend: false,
    });

    // workspace_id comes from the caller's session, never from the request
    // body, and invited_by is stamped server-side. What is stored is the hash
    // of the token in the link, never the token.
    const token = /token=([^&]+)$/.exec(String(body.inviteUrl))![1];
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(inserted).toEqual({
      workspace_id: WORKSPACE,
      email: "new@example.com",
      role: "member",
      invited_by: USER.id,
      token_hash: hash,
    });
    expect(JSON.stringify(inserted)).not.toContain(token);
  });

  it("refuses an API key, which may not put a new person in the workspace", async () => {
    const { app, calls } = appWith({
      apiKeyId: "key-1",
      tables: {
        invitations: { insert: () => ({ data: [created], error: null }) },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "new@example.com",
      role: "admin",
    });

    expect(res.status).toBe(403);
    // A key is a way to become the person who owns it, and RLS would let an
    // admin's key invite an admin — which is a second credential nothing
    // revokes, in somebody else's hands.
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/api keys cannot/i),
    });
    expect(calls.some((c) => c.table === "invitations")).toBe(false);
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
    await expect(res.json()).resolves.toEqual({ error: "They're already in this workspace." });
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
  it("names the workspace and whoever sent the invitation", async () => {
    const { app } = appWith({
      rpc: {
        incoming_invitations: () => ({
          data: [
            {
              id: "inv-1",
              workspace_id: "ws-2",
              workspace_name: "Acme",
              inviter_name: "Ada",
              role: "member",
              created_at: CREATED_AT,
            },
          ],
          error: null,
        }),
      },
    });

    const res = await json(app, "GET", "/invitations/incoming");

    await expect(res.json()).resolves.toEqual([
      {
        id: "inv-1",
        workspaceId: "ws-2",
        workspaceName: "Acme",
        inviterName: "Ada",
        role: "member",
        createdAt: Date.parse(CREATED_AT),
      },
    ]);
  });

  it("survives an inviter with no name", async () => {
    const { app } = appWith({
      rpc: {
        incoming_invitations: () => ({
          data: [
            {
              id: "inv-1",
              workspace_id: "ws-2",
              workspace_name: "Acme",
              inviter_name: null,
              role: "member",
              created_at: CREATED_AT,
            },
          ],
          error: null,
        }),
      },
    });

    const res = await json(app, "GET", "/invitations/incoming");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([expect.objectContaining({ inviterName: null })]);
  });

  /**
   * The route used to select from `invitations` and lean on its policy, which
   * admits an admin's outgoing invitations as well as the caller's incoming
   * ones, and hid the workspace's name from somebody not yet in it. The
   * function decides both from the caller's own account, so the route passes
   * it nothing a caller could choose.
   */
  it("asks the database function, naming nobody", async () => {
    let args: unknown = "not called";
    const { app } = appWith({
      rpc: {
        incoming_invitations: (received) => {
          args = received;
          return { data: [], error: null };
        },
      },
    });

    const res = await json(app, "GET", "/invitations/incoming");

    expect(res.status).toBe(200);
    expect(args ?? {}).toEqual({});
  });

  it("reports a read that failed", async () => {
    const { app } = appWith({
      rpc: { incoming_invitations: () => ({ data: null, error: { message: "boom" } }) },
    });

    const res = await json(app, "GET", "/invitations/incoming");

    expect(res.status).toBe(500);
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

    const res = await json(app, "POST", "/invitations/inv-1/accept", { token: "tok-1" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workspaceId: "ws-2" });
    // The caller is never named here: `accept_invitation` reads auth.uid()
    // itself, so there is no id for a caller to substitute. The token from the
    // email is passed through untouched; the function hashes and compares it.
    expect(args).toEqual({ p_invite_id: "inv-1", p_token: "tok-1" });
  });

  it("refuses without the token from the invitation email, before asking anything", async () => {
    // Since 0090 the token is the credential: an account that merely has the
    // invited address -- which an install that auto-confirms sign-ups hands to
    // anybody -- is not enough.
    let asked = false;
    const { app, calls } = appWith({
      rpc: {
        accept_invitation: () => {
          asked = true;
          return { data: "ws-2", error: null };
        },
      },
    });

    for (const body of [undefined, {}, { token: "" }, { token: "x".repeat(201) }]) {
      const res = await json(app, "POST", "/invitations/inv-1/accept", body);
      expect(res.status).toBe(400);
    }
    expect(asked).toBe(false);
    expect(calls.some((c) => c.table === "invitations")).toBe(false);
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

    const res = await json(app, "POST", "/invitations/someone-elses/accept", { token: "tok-1" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "invitation is not addressed to you",
    });
  });

  /**
   * Telling the admin somebody arrived.
   *
   * An invitation is the one thing in this product that ends somewhere other
   * than where it started: an admin sends it and then has no way of knowing
   * whether it worked, short of checking the member list. The pending list even
   * empties on acceptance, so the only visible trace is an absence.
   *
   * The invitation row is read BEFORE the function consumes it — afterwards it
   * is no longer pending, and the whole reason we can read it at all is that it
   * is addressed to the caller.
   */
  function acceptingApp(fetchImpl: typeof fetch) {
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    return appWith({
      rpc: { accept_invitation: () => ({ data: "ws-2", error: null }) },
      tables: {
        invitations: {
          select: () => ({
            data: { invited_by: "admin-1", workspaces: { name: "Acme" } },
            error: null,
          }),
        },
        profiles: {
          select: (ctx: QueryContext) =>
            ctx.columns?.includes("email")
              ? { data: { name: "Ada Lovelace", email: "ada@example.com" }, error: null }
              : { data: { active_workspace_id: WORKSPACE }, error: null },
        },
      },
    });
  }

  it("tells the person who invited them that they joined", async () => {
    let sent: Record<string, unknown> | undefined;
    const { app } = acceptingApp(async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    });

    const res = await json(app, "POST", "/invitations/inv-1/accept", { token: "tok-1" }, MAIL_ENV);

    expect(res.status).toBe(200);
    expect(sent?.to).toEqual(["ada@example.com"]);
    expect(String(sent?.subject)).toContain("Acme");
    // The person who joined is named by the address the invitation was sent to,
    // which is the only thing about them the inviter already knew.
    expect(String(sent?.text)).toContain(USER.email);
  });

  // The membership is real whether or not the courtesy note arrives. A mail
  // failure that turned this into a 400 would tell somebody who HAS joined that
  // they have not.
  it("still reports the join when the notice cannot be sent", async () => {
    const { app } = acceptingApp(async () => new Response("nope", { status: 500 }));

    const res = await json(app, "POST", "/invitations/inv-1/accept", { token: "tok-1" }, MAIL_ENV);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workspaceId: "ws-2" });
  });
});

describe("POST /invitations/:id/resend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mints a new link, hands only its hash to the database, and mails the link", async () => {
    let reissued: Record<string, unknown> | undefined;
    let sent: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    });
    const { app } = appWith({
      rpc: {
        reissue_invitation: (args) => {
          reissued = args;
          return { data: null, error: null };
        },
      },
      tables: {
        invitations: {
          select: () => ({
            data: {
              id: "inv-1",
              email: "late@example.com",
              role: "member",
              created_at: CREATED_AT,
              workspace_id: WORKSPACE,
            },
            error: null,
          }),
        },
        workspaces: { select: () => ({ data: { name: "Acme" }, error: null }) },
        profiles: {
          select: (ctx: QueryContext) =>
            ctx.columns === "name"
              ? { data: { name: "Ada Lovelace" }, error: null }
              : { data: { active_workspace_id: WORKSPACE }, error: null },
        },
      },
    });

    const res = await json(app, "POST", "/invitations/inv-1/resend", undefined, MAIL_ENV);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inviteUrl: string;
      emailed: boolean;
      needsResend: boolean;
    };
    expect(body).toMatchObject({ emailed: true, needsResend: false });
    const token = /token=([^&]+)$/.exec(body.inviteUrl)![1];
    expect(reissued?.p_invite_id).toBe("inv-1");
    expect(reissued?.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(reissued)).not.toContain(token);
    expect(String(sent?.text)).toContain(body.inviteUrl);
  });

  it("answers 404 for an invitation that is not there or not the caller's to resend", async () => {
    // One code from the function for both, on purpose: an admin of one
    // workspace learns nothing about another's invitations.
    const { app } = appWith({
      tables: { invitations: { select: () => ({ data: null, error: null }) } },
      rpc: {
        reissue_invitation: () => ({
          data: null,
          error: { code: "P0002", message: "invitation not found" },
        }),
      },
    });

    const res = await json(app, "POST", "/invitations/inv-x/resend");
    expect(res.status).toBe(404);
  });
});

describe("the daily ceiling on invitation emails", () => {
  // Any free account is the admin of a workspace, and an invitation is a
  // Covan-branded email to any address. Counted from the event log, which a
  // revoke does not delete from.
  const spent = {
    workspace_events: { select: () => ({ data: null, error: null, count: 50 }) },
  };

  it("refuses a new invitation once the workspace has sent its fifty today", async () => {
    const { app, callsTo } = appWith({ tables: spent });

    const res = await json(app, "POST", "/invitations", { email: "x@example.com", role: "member" });

    expect(res.status).toBe(429);
    expect(callsTo("invitations").some((c) => c.op === "insert")).toBe(false);
  });

  it("refuses a resend too, counted against the invitation's own workspace", async () => {
    const rpc = vi.fn(() => ({ data: null, error: null }));
    const { app, callsTo } = appWith({
      tables: {
        ...spent,
        invitations: { select: () => ({ data: { workspace_id: "ws-other" }, error: null }) },
      },
      rpc: { reissue_invitation: rpc },
    });

    const res = await json(app, "POST", "/invitations/inv-1/resend");

    expect(res.status).toBe(429);
    expect(rpc).not.toHaveBeenCalled();
    const counted = callsTo("workspace_events")[0];
    expect(counted?.filters).toContainEqual({
      column: "workspace_id",
      value: "ws-other",
      kind: "eq",
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
    const body = (await res.json()) as { emailed: boolean; inviteUrl: string };
    expect(body.emailed).toBe(true);

    expect(sent?.url).toBe("https://api.resend.com/emails");
    expect(sent?.body.from).toBe(MAIL_ENV.RESEND_FROM);
    expect(sent?.body.to).toEqual(["new@example.com"]);
    // Fixed: the names are text somebody chose, and the subject is read
    // before anybody decides whether to trust the sender.
    expect(sent?.body.subject).toBe("You're invited to a workspace on Covan");

    const text = String(sent?.body.text);
    // The mail carries the link with the token (0090) — the same one the
    // response hands the admin — on this deployment's own origin, and names
    // the address the account has to have as well.
    expect(body.inviteUrl.startsWith(`${MAIL_ENV.ALLOWED_ORIGIN}/invite#`)).toBe(true);
    expect(text).toContain(body.inviteUrl);
    expect(text).toContain("new@example.com");
    // The link opens a page, never the API: opening it accepts nothing, so a
    // mail scanner following links joins nobody to anything.
    expect(text, "the mail linked straight to the accept endpoint").not.toMatch(
      /\/invitations?\/[\w-]+\/accept/,
    );
  });

  it("sends an HTML half that carries the same facts as the text one", async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const { app } = appWithMail(async (input, init) => {
      sent = { url: String(input), body: JSON.parse(String(init?.body)) };
      return new Response("{}", { status: 200 });
    });

    await json(app, "POST", "/invitations", { email: "new@example.com", role: "member" }, MAIL_ENV);

    const html = String(sent?.body.html);
    // Same three facts the text half is held to, because the two halves are one
    // message and a reader sees only one of them.
    expect(html).toContain("Acme");
    expect(html).toContain("new@example.com");
    expect(html).toContain(`${MAIL_ENV.ALLOWED_ORIGIN}/invite#id=inv-1&amp;token=`);
    expect(html, "the HTML mail linked straight to the accept endpoint").not.toMatch(
      /\/invitations?\/[\w-]+\/accept/,
    );
    // The text half is not replaced by the HTML one; a client that strips
    // styles still has the whole message.
    expect(String(sent?.body.text)).toContain("new@example.com");
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

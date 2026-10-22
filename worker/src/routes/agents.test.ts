import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { agents } from "./agents";
import { DEFAULT_MODEL } from "../lib/models";

/**
 * The agents route, tested where it stopped being a pass-through.
 *
 * It had no test file for as long as every field it accepted was spelled the
 * same in the API and in the database, because there was nothing between the
 * two to get wrong: the handler validated a body and handed it to `.update()`.
 * `reasoningEffort` is the first field where those two spellings differ, and the
 * failure that would cause is not a type error — it is PostgREST refusing a
 * column named `reasoningEffort` at runtime, on the save the user cares about.
 */

const USER_ID = "user-1";
const WORKSPACE_ID = "workspace-1";

const AGENT_ROW = {
  id: "agent-1",
  name: "GTM",
  emoji: "📈",
  model: "gpt-4o",
  persona: "You are our PM.",
  mode: "normal",
  temperature: null as number | null,
  reasoning_effort: null as string | null,
  created_at: "2026-09-01T10:00:00Z",
  agent_bundles: [],
};

/**
 * Enough of the request-scoped client for this route, recording what it was
 * asked to write. `getActiveWorkspaceId` reads `profiles`; everything else is
 * the agents table.
 */
function fakeDb(
  opts: {
    /** Rows an update matched; [] is RLS refusing it (0104). */
    updated?: unknown[];
    /** What `set_agent_sharing` answers. */
    sharingError?: { code: string; message: string } | null;
    /** The agent as the database has it. */
    row?: typeof AGENT_ROW | (Omit<typeof AGENT_ROW, "model"> & { model: string | null });
  } = {},
) {
  const writes: Record<string, unknown>[] = [];
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      return { data: null, error: opts.sharingError ?? null };
    },
    from(table: string) {
      if (table === "profiles") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: { active_workspace_id: WORKSPACE_ID }, error: null }),
          single: async () => ({ data: { active_workspace_id: WORKSPACE_ID }, error: null }),
        };
        return chain;
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        maybeSingle: async () => ({ data: opts.row ?? AGENT_ROW, error: null }),
        single: async () => ({ data: opts.row ?? AGENT_ROW, error: null }),
        update(patch: Record<string, unknown>) {
          writes.push(patch);
          return chain;
        },
        // An awaited chain is an update's `.select("id")`: the rows it matched.
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: opts.updated ?? [{ id: AGENT_ROW.id }], error: null }),
        insert(row: Record<string, unknown>) {
          writes.push(row);
          return chain;
        },
      };
      return chain;
    },
  };
  return { db, writes, rpcs };
}

function appWith(db: unknown) {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: USER_ID, email: "a@example.com" } as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", agents);
  return app;
}

const patch = (app: Hono<AppEnv>, body: unknown) =>
  app.request("/agents/agent-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /agents/:id", () => {
  /**
   * `model` was `z.string().optional()` while `reasoningEffort` two lines below
   * it was already `z.enum(...)`, so an agent could be pointed at any string at
   * all — a typo, a retired id, a model from a different provider's catalogue —
   * and the first sign of it would be every reply arriving from `DEFAULT_MODEL`
   * because `resolveModel` fell the unknown id through.
   *
   * Checked against production before narrowing it: all 55 agents held ids that
   * are in `MODEL_IDS`, so nothing already stored is locked out of a PATCH of
   * some other field.
   */
  it("refuses a model id that is not in the catalogue", async () => {
    const { db, writes } = fakeDb();

    const res = await patch(appWith(db), { model: "gpt-4.2-turbo" });

    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("still takes every id the catalogue does offer", async () => {
    const { db, writes } = fakeDb();

    const res = await patch(appWith(db), { model: "claude-sonnet-5" });

    expect(res.status).toBe(200);
    expect(writes[0]).toEqual({ model: "claude-sonnet-5" });
  });

  it("writes the reasoning effort to the column that exists", async () => {
    const { db, writes } = fakeDb();

    const res = await patch(appWith(db), { reasoningEffort: "high" });

    expect(res.status).toBe(200);
    expect(writes[0]).toEqual({ reasoning_effort: "high" });
    expect(writes[0]).not.toHaveProperty("reasoningEffort");
  });

  it("writes only the fields that were sent", async () => {
    // A PATCH of one field has to stay a PATCH of one field: filling the others
    // in from defaults would let the settings page overwrite a persona somebody
    // else had just changed in another tab.
    const { db, writes } = fakeDb();

    await patch(appWith(db), { name: "Growth" });

    expect(writes[0]).toEqual({ name: "Growth" });
  });

  it("takes null, which is how a setting is put back on Auto", async () => {
    // The difference this pins: absent means "leave it alone" and null means
    // "clear it". Without the second, a temperature could be set and never unset.
    const { db, writes } = fakeDb();

    await patch(appWith(db), { temperature: null, reasoningEffort: null });

    expect(writes[0]).toEqual({ temperature: null, reasoning_effort: null });
  });

  it("takes 0, which is a temperature and not an empty field", async () => {
    const { db, writes } = fakeDb();

    await patch(appWith(db), { temperature: 0 });

    expect(writes[0]).toEqual({ temperature: 0 });
  });

  it("refuses a temperature outside what the providers accept", async () => {
    // The database says the same thing (0048). This is what turns it into a 400
    // naming the field rather than a 500 naming a constraint.
    const { db, writes } = fakeDb();

    const res = await patch(appWith(db), { temperature: 3 });

    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("refuses an effort the API has no name for", async () => {
    const { db, writes } = fakeDb();

    const res = await patch(appWith(db), { reasoningEffort: "maximum" });

    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("still refuses an empty body", async () => {
    const { db } = fakeDb();

    expect((await patch(appWith(db), {})).status).toBe(400);
  });

  it("returns the agent with both settings on it", async () => {
    const { db } = fakeDb();

    const res = await patch(appWith(db), { name: "Growth" });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ temperature: null, reasoningEffort: null });
  });
});

describe("an agent with no model of its own", () => {
  // The welcome's first agent was made with none for as long as the welcome
  // passed none. The deployment's default answers it, so the screens are
  // given that — a composer with no model to name shows an empty chip.
  it("is shown with the model that answers it", async () => {
    const { db } = fakeDb({ row: { ...AGENT_ROW, model: null } });

    const res = await patch(appWith(db), { name: "Growth" });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.model).toBe(DEFAULT_MODEL);
  });

  it("keeps a model somebody picked", async () => {
    const { db } = fakeDb();

    const res = await patch(appWith(db), { name: "Growth" });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.model).toBe("gpt-4o");
  });
});

describe("POST /agents", () => {
  it("creates an agent on Auto when nothing was asked for", async () => {
    const { db, writes } = fakeDb();

    const res = await appWith(db).request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GTM" }),
    });

    expect(res.status).toBe(201);
    expect(writes[0]).toMatchObject({ temperature: null, reasoning_effort: null });
  });

  /**
   * On by default since 2026-09-17 (`037cd94`, "web search should be the
   * default modern experience"), and off again from 2026-09-29 on a
   * measurement that did not exist when that was decided: attaching
   * Anthropic's `web_search` costs **5,588 prompt tokens on every request**,
   * searched or not, at the front of the cacheable prefix — ~36% of a cold
   * turn's cost. 35 of 40 live agents already have it off, nothing recorded
   * whether a single search had ever run, and the column default in migration
   * 0051 was `false` all along; only this route overrode it.
   *
   * The toggle is untouched, and no existing agent changes: the column is
   * already written for every one of them. See covan-ai/covan#228.
   */
  it("leaves web search off unless the caller asks for it", async () => {
    const { db, writes } = fakeDb();

    await appWith(db).request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GTM" }),
    });

    expect(writes[0]).toMatchObject({ web_search: false });
  });

  it("still turns it on for a caller that does ask", async () => {
    const { db, writes } = fakeDb();

    await appWith(db).request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GTM", webSearch: true }),
    });

    expect(writes[0]).toMatchObject({ web_search: true });
  });

  it("takes both settings when the caller does name them", async () => {
    const { db, writes } = fakeDb();

    await appWith(db).request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GTM", temperature: 0.2, reasoningEffort: "low" }),
    });

    expect(writes[0]).toMatchObject({ temperature: 0.2, reasoning_effort: "low" });
  });
});

describe("PATCH /agents/:id, for somebody who can only use the agent", () => {
  // RLS answers an update it refuses by matching no rows. This route used to
  // report that as a 200 with the unchanged agent — a save that said it worked.
  it("says so instead of pretending the save worked", async () => {
    const { db } = fakeDb({ updated: [] });

    const res = await patch(appWith(db), { persona: "Something else" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "you can use this agent but not change it" });
  });
});

describe("PUT /agents/:id/sharing", () => {
  const put = (app: Hono<AppEnv>, body: unknown) =>
    app.request("/agents/agent-1/sharing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const MEMBER = "33333333-3333-4333-8333-333333333333";

  it("hands the whole list to set_agent_sharing, in the database's spelling", async () => {
    const { db, rpcs } = fakeDb();

    const res = await put(appWith(db), {
      workspaceAccess: null,
      shares: [{ userId: MEMBER, access: "edit" }],
    });

    expect(res.status).toBe(200);
    expect(rpcs).toEqual([
      {
        name: "set_agent_sharing",
        args: {
          p_agent_id: "agent-1",
          p_workspace_access: null,
          p_shares: [{ user_id: MEMBER, access: "edit" }],
        },
      },
    ]);
  });

  it("refuses a level that is not one of the three", async () => {
    const { db, rpcs } = fakeDb();

    const res = await put(appWith(db), {
      workspaceAccess: "admin",
      shares: [],
    });

    expect(res.status).toBe(400);
    expect(rpcs).toHaveLength(0);
  });

  it("turns not-full-access into a 403 a person can read", async () => {
    const { db } = fakeDb({ sharingError: { code: "42501", message: "no" } });

    const res = await put(appWith(db), { workspaceAccess: "use", shares: [] });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/full access/);
  });

  it("passes the database's own sentence through when the list is wrong", async () => {
    const { db } = fakeDb({
      sharingError: { code: "22023", message: "that person is not a member of this workspace" },
    });

    const res = await put(appWith(db), {
      workspaceAccess: null,
      shares: [{ userId: MEMBER, access: "use" }],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "that person is not a member of this workspace" });
  });
});

describe("the agent's face (0120)", () => {
  it("writes the mark on create and on edit, and null puts the monogram back", async () => {
    const { db, writes } = fakeDb();
    const app = appWith(db);

    const created = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Support", avatar: "headset" }),
    });
    expect(created.status).toBe(201);
    expect(writes[0]).toMatchObject({ name: "Support", avatar: "headset" });

    expect((await patch(app, { avatar: "owl" })).status).toBe(200);
    expect(writes[1]).toEqual({ avatar: "owl" });

    expect((await patch(app, { avatar: null })).status).toBe(200);
    expect(writes[2]).toEqual({ avatar: null });
  });

  it("refuses a mark that is not one of the eight", async () => {
    const { db, writes } = fakeDb();
    const res = await patch(appWith(db), { avatar: "unicorn" });
    expect(res.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it("sends the mark back on the agent, and nothing for a name it does not know", async () => {
    const { mapAgent } = await import("../lib/dto");
    expect(mapAgent({ ...AGENT_ROW, avatar: "fox" }).avatar).toBe("fox");
    expect(mapAgent({ ...AGENT_ROW, avatar: "dragon" }).avatar).toBeNull();
    expect(mapAgent(AGENT_ROW).avatar).toBeNull();
  });
});

describe("GET /agents/:id/delete-summary", () => {
  function summaryDb(answer: { data?: unknown; error?: { code: string; message: string } }) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      db: {
        rpc(name: string, args: Record<string, unknown>) {
          calls.push({ name, args });
          return {
            maybeSingle: async () => ({ data: answer.data ?? null, error: answer.error ?? null }),
          };
        },
      },
    };
  }

  it("says what a delete takes with it", async () => {
    const { db, calls } = summaryDb({ data: { threads: 19, routines: 2, folders: 3 } });
    const res = await appWith(db).request("/agents/agent-1/delete-summary");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: 19, routines: 2, folders: 3 });
    expect(calls).toEqual([{ name: "agent_delete_summary", args: { p_agent_id: "agent-1" } }]);
  });

  it("answers somebody who could not delete it as the button would", async () => {
    const refused = summaryDb({ error: { code: "42501", message: "no" } });
    expect((await appWith(refused.db).request("/agents/agent-1/delete-summary")).status).toBe(403);
    const missing = summaryDb({ error: { code: "P0002", message: "no" } });
    expect((await appWith(missing.db).request("/agents/agent-1/delete-summary")).status).toBe(404);
  });
});

describe("GET /agents/:id/knowledge-usage", () => {
  function usageDb(
    answer: { data?: unknown; error?: { code: string; message: string } },
    grounding: unknown = [],
  ) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      db: {
        async rpc(name: string, args: Record<string, unknown>) {
          calls.push({ name, args });
          if (name === "agent_coverage") return { data: grounding, error: answer.error ?? null };
          return { data: answer.data ?? null, error: answer.error ?? null };
        },
      },
    };
  }

  it("answers the replies each folder grounded, over thirty days unless asked", async () => {
    const { db, calls } = usageDb({
      data: [
        { bundle_id: "policies", replies: 61 },
        { bundle_id: "templates", replies: 0 },
      ],
    });
    const res = await appWith(db).request("/agents/agent-1/knowledge-usage");
    expect(await res.json()).toEqual({
      byBundle: { policies: { replies: 61 }, templates: { replies: 0 } },
      answers: 0,
      grounding: { covered: 0, fallback: 0, ungrounded: 0 },
      notCoveredPct: null,
    });
    expect(calls[0]!.args).toEqual({ p_agent_id: "agent-1", p_days: 30 });
  });

  it("says how much of what it was asked was not covered (0134)", async () => {
    const { db } = usageDb({ data: [] }, [
      { answers: 312, covered: 181, fallback: 100, ungrounded: 31 },
    ]);
    const res = await appWith(db).request("/agents/agent-1/knowledge-usage?days=30");
    expect(await res.json()).toMatchObject({
      answers: 312,
      grounding: { covered: 181, fallback: 100, ungrounded: 31 },
      notCoveredPct: 42,
    });
  });

  it("answers an agent the caller cannot use as not there", async () => {
    const { db } = usageDb({ error: { code: "P0002", message: "no" } });
    expect((await appWith(db).request("/agents/agent-1/knowledge-usage")).status).toBe(404);
  });
});

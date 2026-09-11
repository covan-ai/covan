import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { agents } from "./agents";

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
function fakeDb() {
  const writes: Record<string, unknown>[] = [];
  const db = {
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
        maybeSingle: async () => ({ data: AGENT_ROW, error: null }),
        single: async () => ({ data: AGENT_ROW, error: null }),
        update(patch: Record<string, unknown>) {
          writes.push(patch);
          return chain;
        },
        insert(row: Record<string, unknown>) {
          writes.push(row);
          return chain;
        },
      };
      return chain;
    },
  };
  return { db, writes };
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

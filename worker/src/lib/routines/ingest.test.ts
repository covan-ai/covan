import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RoutineEnv } from "../../types";

const triggerSelect = vi.fn();
const routineSelect = vi.fn();
const updated: unknown[] = [];
let triggerFilter: { column: string; value: unknown } | null = null;

vi.mock("../supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "routine_triggers") {
        return {
          select: () => ({
            eq: (column: string, value: unknown) => {
              triggerFilter = { column, value };
              return { maybeSingle: triggerSelect };
            },
          }),
          update: (values: unknown) => {
            updated.push(values);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: routineSelect }) }) };
    },
  }),
}));

const {
  INGEST_TOKEN_PREFIX,
  generateIngestToken,
  hashIngestToken,
  resolveIngestToken,
  touchTrigger,
} = await import("./ingest");
const { looksLikeApiKey } = await import("../api-keys");

const ENV = {} as RoutineEnv;
const TOKEN = `${INGEST_TOKEN_PREFIX}abc`;

const routine = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  agent_id: "a1",
  user_id: "u1",
  workspace_id: "w1",
  name: "Deploys",
  source_kind: "none",
  source_config: {},
  instruction: "Summarise",
  delivery_channel_id: "c1",
  schedule_cron: "0 9 * * *",
  timezone: "UTC",
  next_run_at: "2026-09-20T09:00:00.000Z",
  cursor: null,
  consecutive_failures: 0,
  status: "active",
  trigger_kind: "webhook",
  deleted_at: null,
  ...over,
});

beforeEach(() => {
  triggerSelect.mockReset().mockResolvedValue({ data: { routine_id: "r1" }, error: null });
  routineSelect.mockReset().mockResolvedValue({ data: routine(), error: null });
  updated.length = 0;
  triggerFilter = null;
});

describe("the ingest token", () => {
  it("is one selectable word with its own prefix", () => {
    const { token } = generateIngestToken();
    expect(token.startsWith(INGEST_TOKEN_PREFIX)).toBe(true);
    expect(token.slice(INGEST_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateIngestToken().token));
    expect(seen.size).toBe(50);
  });

  // `authMiddleware` decides a bearer token is an API key by its prefix. A
  // collision would send an ingest token down the key lookup — and, worse,
  // suggest the two grant the same thing. They do not: a key is an identity,
  // this is one permission on one row.
  it("is not mistaken for an API key", () => {
    expect(looksLikeApiKey(generateIngestToken().token)).toBe(false);
  });

  it("is stored as a digest, never as itself", async () => {
    const { token, tokenHash } = generateIngestToken();
    const hash = await tokenHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(await hashIngestToken(token)).toBe(hash);
  });
});

describe("resolveIngestToken", () => {
  it("returns the routine the token names", async () => {
    const result = await resolveIngestToken(ENV, TOKEN);
    expect(result).toMatchObject({ ok: true, routine: { id: "r1" } });
  });

  // The token itself must never appear in a query. The database holds a
  // SHA-256 precisely so that a copy of it is not a copy of the credential,
  // and a lookup by the raw value would put the credential in the query log.
  it("matches on the hash, never on the token", async () => {
    await resolveIngestToken(ENV, TOKEN);

    expect(triggerFilter).toEqual({ column: "token_hash", value: await hashIngestToken(TOKEN) });
    expect(triggerFilter?.value).not.toBe(TOKEN);
  });

  // One answer for every way of not holding a valid token, so the endpoint
  // cannot be used to find out which tokens exist.
  it.each([
    ["nothing at all", undefined],
    ["an empty string", ""],
    ["something with the wrong prefix", "covan_sk_pretending"],
  ])("refuses %s with the same 401", async (_case, token) => {
    expect(await resolveIngestToken(ENV, token)).toEqual({
      ok: false,
      status: 401,
      error: "unknown ingest token",
    });
  });

  it("refuses an unknown token with that same answer", async () => {
    triggerSelect.mockResolvedValue({ data: null, error: null });
    expect(await resolveIngestToken(ENV, TOKEN)).toMatchObject({ status: 401 });
  });

  it("treats a trigger whose routine is deleted as unknown", async () => {
    routineSelect.mockResolvedValue({
      data: routine({ deleted_at: "2026-09-01T00:00:00Z" }),
      error: null,
    });
    expect(await resolveIngestToken(ENV, TOKEN)).toMatchObject({ status: 401 });
  });

  // Past the token check the caller has proved they hold it, so these say what
  // is wrong. Answering 401 would send somebody hunting for a credential
  // problem that is not there.
  it("says so when the routine is paused", async () => {
    routineSelect.mockResolvedValue({ data: routine({ status: "paused" }), error: null });
    const result = await resolveIngestToken(ENV, TOKEN);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toMatch(/paused/);
  });

  it("says so when the routine stopped accepting pokes", async () => {
    routineSelect.mockResolvedValue({ data: routine({ trigger_kind: "schedule" }), error: null });
    const result = await resolveIngestToken(ENV, TOKEN);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toMatch(/webhook/);
  });

  it("accepts a routine that runs on both", async () => {
    routineSelect.mockResolvedValue({ data: routine({ trigger_kind: "both" }), error: null });
    expect(await resolveIngestToken(ENV, TOKEN)).toMatchObject({ ok: true });
  });

  // A database that had a bad second is not a token that is wrong.
  it("does not blame the caller for a failed lookup", async () => {
    triggerSelect.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await resolveIngestToken(ENV, TOKEN)).toMatchObject({ status: 409 });
  });
});

describe("touchTrigger", () => {
  it("records only a clock reading", async () => {
    await touchTrigger(ENV, "r1");
    expect(updated).toHaveLength(1);
    expect(Object.keys(updated[0] as object)).toEqual(["last_used_at"]);
  });
});

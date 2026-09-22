import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptSecret } from "../secret-box";
import type { ToolConnection } from "./connections";
import type { ToolEnv } from "./registry";

/**
 * Where a connection's credential comes from, now that it is not always the
 * connection's own.
 *
 * A project connected through a Supabase account holds no ciphertext of its
 * own (0061): the token belongs to the account and exactly one copy of it
 * exists. What has to be true is that this file follows `account_id` to find
 * it, and that a row naming no account fails loudly rather than reaching for a
 * column that is null.
 */
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const reads: Array<{ table: string; column: string; id: string }> = [];
let rows: Record<string, Record<string, unknown> | null> = {};

vi.mock("../supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: (_columns: string) => ({
        eq: (column: string, id: string) => ({
          maybeSingle: async () => {
            reads.push({ table, column, id });
            return { data: rows[table] ?? null, error: null };
          },
        }),
      }),
    }),
  }),
}));

const { authHeaders } = await import("./secrets");

const ENV = { ROUTINE_SECRET_KEY: KEY } as ToolEnv;

function connection(over: Partial<ToolConnection> = {}): ToolConnection {
  return {
    id: "conn-1",
    workspace_id: "ws-1",
    label: "covan-prod",
    transport: "supabase",
    base_url: "https://api.supabase.com",
    auth_kind: "static_header",
    allowed_methods: ["GET"],
    config: { ref: "abcdefghijklmnop" },
    account_id: "acct-1",
    ...over,
  };
}

beforeEach(() => {
  reads.length = 0;
  rows = {};
});

describe("authHeaders", () => {
  it("reads a connected project's token from the account it borrows", async () => {
    rows.supabase_accounts = {
      token_ciphertext: await encryptSecret(
        JSON.stringify({ headers: { Authorization: "Bearer sbp_token" } }),
        KEY,
      ),
    };

    const headers = await authHeaders(ENV, connection());

    expect(headers).toEqual({ Authorization: "Bearer sbp_token" });
    expect(reads).toEqual([{ table: "supabase_accounts", column: "id", id: "acct-1" }]);
  });

  it("still reads an ordinary connection's own credential", async () => {
    rows.tool_connections = {
      secret_ciphertext: await encryptSecret(JSON.stringify({ headers: { apikey: "k" } }), KEY),
    };

    const headers = await authHeaders(ENV, connection({ transport: "sql", account_id: null }));

    expect(headers).toEqual({ apikey: "k" });
    expect(reads[0].table).toBe("tool_connections");
  });

  it("says so when a Supabase row names no account", async () => {
    await expect(authHeaders(ENV, connection({ account_id: null }))).rejects.toThrow(/account/i);
    expect(reads).toEqual([]);
  });
});

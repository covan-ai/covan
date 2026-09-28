import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptSecret } from "../secret-box";
import type { ToolConnection } from "./connections";
import type { ToolEnv } from "./registry";

/**
 * Where a connection's credential comes from, and where it does not.
 *
 * Two answers now rather than three. An ordinary connection holds its own
 * encrypted envelope, and a connected application holds nothing at all —
 * Composio authenticates the deployment, so the key is on the environment and
 * no row is read. The third answer, a project borrowing a Supabase account's
 * Management token (0061), went with that feature in 0067.
 *
 * What has to stay true is the second one: a `composio` row must never fall
 * through to the ordinary read, which would find a NULL ciphertext and fail
 * with a sentence about a missing credential that is true of every row and
 * explains nothing.
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
    transport: "sql",
    base_url: "https://db.example.com/rest/v1",
    auth_kind: "static_header",
    allowed_methods: ["GET"],
    config: {},
    toolkit_slug: null,
    status: "active",
    ...over,
  };
}

beforeEach(() => {
  reads.length = 0;
  rows = {};
});

describe("authHeaders", () => {
  it("still reads an ordinary connection's own credential", async () => {
    rows.tool_connections = {
      secret_ciphertext: await encryptSecret(JSON.stringify({ headers: { apikey: "k" } }), KEY),
    };

    const headers = await authHeaders(ENV, connection());

    expect(headers).toEqual({ apikey: "k" });
    expect(reads[0].table).toBe("tool_connections");
  });

  it("authenticates a connected application from the environment, reading no row", async () => {
    // Composio authenticates the DEPLOYMENT. There is no envelope to decrypt
    // and no per-workspace credential to find — which is exactly why 0063 keeps
    // the account reference out of every client role's reach, since on this
    // arrangement that id is the only thing separating two tenants.
    const headers = await authHeaders(
      { ...ENV, COMPOSIO_API_KEY: "ck_test" } as ToolEnv,
      connection({ transport: "composio", auth_kind: "composio" }),
    );

    expect(headers).toEqual({ "x-api-key": "ck_test" });
    expect(reads).toEqual([]);
  });

  it("refuses a connected application on a deployment with no key", async () => {
    await expect(authHeaders(ENV, connection({ transport: "composio" }))).rejects.toThrow(
      /COMPOSIO_API_KEY/,
    );
  });
});

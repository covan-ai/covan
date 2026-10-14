import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../secret-box";

const revoke = vi.fn();
vi.mock("./registry", () => ({
  providerFor: (id: string) =>
    id === "google_drive" ? { id, revoke: (...args: unknown[]) => revoke(...args) } : { id },
}));

const { releaseHeldConnections } = await import("./release");

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** The service-role client, answering the held connections and recording updates. */
function admin(rows: Array<Record<string, unknown>>) {
  const updates: Array<{ id: unknown; values: Record<string, unknown> }> = [];
  const db = {
    from: () => ({
      select: () => ({ eq: async () => ({ data: rows, error: null }) }),
      update: (values: Record<string, unknown>) => ({
        eq: async (_col: string, id: unknown) => {
          updates.push({ id, values });
          return { error: null };
        },
      }),
    }),
  };
  return { db: db as never, updates };
}

/**
 * Closing an account lets go of the sources that person connected. Before,
 * the token stayed in the row and stayed valid at Google, for an account that
 * had asked to be erased.
 */
describe("releaseHeldConnections", () => {
  it("revokes at the provider, and clears and pauses the source where it stays", async () => {
    const secret = await encryptSecret(
      JSON.stringify({ accessToken: "a", refreshToken: "r" }),
      KEY,
    );
    const { db, updates } = admin([
      {
        id: "drive-stays",
        workspace_id: "team",
        provider: "google_drive",
        secret_ciphertext: secret,
      },
      {
        id: "drive-goes",
        workspace_id: "solo",
        provider: "google_drive",
        secret_ciphertext: secret,
      },
      { id: "notion-stays", workspace_id: "team", provider: "notion", secret_ciphertext: secret },
    ]);

    await releaseHeldConnections({ ROUTINE_SECRET_KEY: KEY } as never, db, "user-1", ["solo"]);

    // Both Drive grants are revoked, the one whose workspace is closing too.
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke.mock.calls[0][1]).toEqual({ accessToken: "a", refreshToken: "r" });
    // The rows that stay lose the token and wait for somebody to reconnect;
    // the one in the closing workspace goes with it.
    expect(updates.map((u) => u.id)).toEqual(["drive-stays", "notion-stays"]);
    expect(updates[0].values).toMatchObject({
      secret_ciphertext: "",
      status: "paused",
      paused_code: "owner_gone",
    });
  });

  it("still clears the token when the provider refuses to revoke", async () => {
    revoke.mockRejectedValueOnce(new Error("google is down"));
    const secret = await encryptSecret(JSON.stringify({ accessToken: "a" }), KEY);
    const { db, updates } = admin([
      { id: "drive", workspace_id: "team", provider: "google_drive", secret_ciphertext: secret },
    ]);

    await releaseHeldConnections({ ROUTINE_SECRET_KEY: KEY } as never, db, "user-1", []);

    expect(updates.map((u) => u.id)).toEqual(["drive"]);
  });
});

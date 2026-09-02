import { describe, it, expect, vi, beforeEach } from "vitest";

const getSession = vi.fn();
vi.mock("./client", () => ({ supabase: { auth: { getSession } } }));

const { readSession } = await import("./session");

/**
 * The three answers exist because supabase-js has three outcomes and the app
 * used to see two. Measured in Chrome against a token endpoint that dropped the
 * connection: `getSession()` spent 21s retrying and then returned
 * `{ session: null, error: AuthRetryableFetchError }` — with the session still
 * in localStorage. A dead refresh token returns `{ session: null, error: null }`
 * and clears storage. Same null, opposite meanings.
 */
describe("reading the stored session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the session when there is one", async () => {
    const session = { access_token: "a", refresh_token: "b" };
    getSession.mockResolvedValue({ data: { session }, error: null });

    await expect(readSession()).resolves.toEqual({ kind: "session", session });
  });

  it("reports nobody signed in when supabase says so and means it", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    await expect(readSession()).resolves.toEqual({ kind: "none" });
  });

  // The whole point. Answering "none" here is what signed people out.
  it("reports that it could not tell when the lookup failed", async () => {
    const error = Object.assign(new Error("Failed to fetch"), {
      name: "AuthRetryableFetchError",
    });
    getSession.mockResolvedValue({ data: { session: null }, error });

    await expect(readSession()).resolves.toEqual({ kind: "unknown" });
  });

  // supabase-js rejects rather than resolves if storage itself throws — a
  // Safari private window, or a browser with site data switched off. That is
  // also "could not tell", not "signed out".
  it("reports that it could not tell when the lookup throws", async () => {
    getSession.mockRejectedValue(new Error("localStorage is not available"));

    await expect(readSession()).resolves.toEqual({ kind: "unknown" });
  });
});

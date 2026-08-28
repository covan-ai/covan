import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Bindings } from "../types";
import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
  mintUserToken,
  resolveApiKey,
  touchApiKey,
} from "./api-keys";

/**
 * The two things this file has to get right are the two that cannot be seen
 * from a route test.
 *
 * A key must never be reconstructible from what is stored, and the token minted
 * for its owner must be a token the project would actually accept — a signature
 * that is subtly wrong fails at the first query, in a place that looks like a
 * database problem rather than a signing one.
 */

const SECRET = "a-jwt-secret-that-is-long-enough-to-be-plausible";

describe("the key itself", () => {
  it("is recognisable without being parsed", async () => {
    const { token } = await generateApiKey();

    expect(looksLikeApiKey(token)).toBe(true);
    // A Supabase session JWT is what the other branch of authMiddleware takes,
    // and the two must never be confusable.
    expect(looksLikeApiKey("eyJhbGciOiJIUzI1NiJ9.e30.sig")).toBe(false);
  });

  it("stores a hash and a head, and neither is the key", async () => {
    const { token, tokenHash, prefix } = await generateApiKey();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(token.startsWith(prefix)).toBe(true);
    // Enough to tell two rows apart in a list, nowhere near enough to guess.
    expect(prefix.length).toBeLessThan(token.length / 2);
  });

  it("does not repeat itself", async () => {
    const keys = await Promise.all(Array.from({ length: 50 }, () => generateApiKey()));

    expect(new Set(keys.map((k) => k.token)).size).toBe(50);
    expect(new Set(keys.map((k) => k.tokenHash)).size).toBe(50);
  });

  it("hashes the same key to the same digest, and different keys apart", async () => {
    const a = `${API_KEY_PREFIX}aaaa`;
    const b = `${API_KEY_PREFIX}aaab`;

    expect(await hashApiKey(a)).toBe(await hashApiKey(a));
    expect(await hashApiKey(a)).not.toBe(await hashApiKey(b));
  });
});

describe("the token minted for a key's owner", () => {
  const user = { id: "user-1", email: "a@example.com" } as never;

  /** Decode without verifying — the claims are what these assertions are about. */
  function claims(jwt: string): Record<string, unknown> {
    const [, payload] = jwt.split(".");
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  }

  it("names the user Postgres will resolve as auth.uid()", async () => {
    const token = await mintUserToken(SECRET, user);

    expect(claims(token).sub).toBe("user-1");
    // Without this PostgREST stays in the anon role and every policy that
    // mentions auth.uid() refuses, which would look like a permissions bug.
    expect(claims(token).role).toBe("authenticated");
    expect(claims(token).aud).toBe("authenticated");
    expect(claims(token).email).toBe("a@example.com");
  });

  it("expires in a minute, so a captured one is worth nothing by the time it is read", async () => {
    const token = await mintUserToken(SECRET, user);
    const { iat, exp } = claims(token) as { iat: number; exp: number };

    expect(exp - iat).toBe(60);
    expect(exp * 1000).toBeGreaterThan(Date.now());
  });

  it("carries a signature the secret verifies and a different secret does not", async () => {
    const token = await mintUserToken(SECRET, user);
    const [header, payload, signature] = token.split(".");

    const verify = async (secret: string) => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const b64 = signature.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      return crypto.subtle.verify(
        "HMAC",
        key,
        bytes,
        new TextEncoder().encode(`${header}.${payload}`),
      );
    };

    expect(await verify(SECRET)).toBe(true);
    expect(await verify("not-the-project-secret")).toBe(false);
  });

  it("says HS256 in the header, which is what the project signs sessions with", async () => {
    const [header] = (await mintUserToken(SECRET, user)).split(".");

    expect(JSON.parse(atob(header))).toEqual({ alg: "HS256", typ: "JWT" });
  });
});

// ---- lookup ----------------------------------------------------------------

const getUserById = vi.fn();
const from = vi.fn();
const serviceClient = vi.fn((_env: unknown) => ({ from, auth: { admin: { getUserById } } }));

vi.mock("./supabase", () => ({
  serviceClient: (env: unknown) => serviceClient(env),
}));

const ENV = { SUPABASE_URL: "https://example.supabase.co" } as Bindings;

/** One `from("api_keys")` chain, ending in `maybeSingle()` or a bare await. */
function chain(result: { data: unknown; error: unknown }) {
  const link = {
    select: () => link,
    eq: () => link,
    is: () => link,
    update: () => link,
    maybeSingle: async () => result,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return link;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveApiKey", () => {
  it("answers with the key's owner", async () => {
    from.mockReturnValue(
      chain({
        data: { id: "key-1", workspace_id: "ws-1", user_id: "user-1", last_used_at: null },
        error: null,
      }),
    );
    getUserById.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });

    const resolved = await resolveApiKey(ENV, `${API_KEY_PREFIX}abc`);

    expect(resolved?.keyId).toBe("key-1");
    expect(resolved?.workspaceId).toBe("ws-1");
    expect(resolved?.user).toEqual({ id: "user-1" });
  });

  it.each([
    ["an unknown key", { data: null, error: null }],
    ["a lookup that failed", { data: null, error: { message: "boom" } }],
  ])("answers null for %s", async (_label, result) => {
    from.mockReturnValue(chain(result));

    await expect(resolveApiKey(ENV, `${API_KEY_PREFIX}abc`)).resolves.toBeNull();
    // Nothing to look a user up for, so no second round trip is spent.
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("answers null when the owner's account is gone", async () => {
    // The row outlives the account only until the cascade runs, and a request in
    // that window must not be honoured as a user who no longer exists.
    from.mockReturnValue(
      chain({
        data: { id: "key-1", workspace_id: "ws-1", user_id: "user-1", last_used_at: null },
        error: null,
      }),
    );
    getUserById.mockResolvedValue({ data: { user: null }, error: null });

    await expect(resolveApiKey(ENV, `${API_KEY_PREFIX}abc`)).resolves.toBeNull();
  });

  it("looks the key up by hash and excludes revoked rows", async () => {
    const filters: { method: string; args: unknown[] }[] = [];
    const link = {
      select: () => link,
      eq: (...args: unknown[]) => (filters.push({ method: "eq", args }), link),
      is: (...args: unknown[]) => (filters.push({ method: "is", args }), link),
      maybeSingle: async () => ({ data: null, error: null }),
    };
    from.mockReturnValue(link);

    const token = `${API_KEY_PREFIX}abc`;
    await resolveApiKey(ENV, token);

    // The plaintext must never appear in a query — what is stored is the digest,
    // and asking by anything else would mean the column held the key itself.
    expect(filters).toContainEqual({ method: "eq", args: ["token_hash", await hashApiKey(token)] });
    expect(JSON.stringify(filters)).not.toContain(token);
    expect(filters).toContainEqual({ method: "is", args: ["revoked_at", null] });
  });
});

describe("touchApiKey", () => {
  const key = { keyId: "key-1", workspaceId: "ws-1", user: { id: "user-1" } as never };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes when the stored value is stale", async () => {
    const update = vi.fn(() => ({ eq: async () => ({ data: null, error: null }) }));
    from.mockReturnValue({ update });

    await touchApiKey(ENV, { ...key, lastUsedAt: new Date(Date.now() - 3_600_000).toISOString() });

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("writes when there is no stored value at all", async () => {
    const update = vi.fn(() => ({ eq: async () => ({ data: null, error: null }) }));
    from.mockReturnValue({ update });

    await touchApiKey(ENV, { ...key, lastUsedAt: null });

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does not put a write in front of every request", async () => {
    // The point of the throttle: a key used in a loop should cost one UPDATE
    // every five minutes, not one per request.
    const update = vi.fn(() => ({ eq: async () => ({ data: null, error: null }) }));
    from.mockReturnValue({ update });

    await touchApiKey(ENV, { ...key, lastUsedAt: new Date(Date.now() - 1_000).toISOString() });

    expect(update).not.toHaveBeenCalled();
  });
});

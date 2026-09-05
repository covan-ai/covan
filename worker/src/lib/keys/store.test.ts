import { describe, it, expect, vi } from "vitest";

import { readWorkspaceKeys, readKeyHints, writeWorkspaceKey } from "./store";
import { encryptSecret } from "./crypto";
import type { RoutineEnv } from "../../types";

const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** A Supabase client stub that answers one `.maybeSingle()` with `row`. */
function dbReturning(row: unknown, error: unknown = null) {
  const chain = {
    select: vi.fn((_columns: string) => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: row, error })),
    upsert: vi.fn(async (_row: Record<string, unknown>) => ({ error: null })),
  };
  return { from: vi.fn(() => chain), chain };
}

vi.mock("../supabase", () => ({
  serviceClient: vi.fn(() => currentDb),
}));

let currentDb: ReturnType<typeof dbReturning>;

// `as unknown as RoutineEnv` rather than `as never`: this stub only carries the
// fields the module under test reads, and `never` makes every later `{
// ...ENV }` fail `tsc --strict` with "Spread types may only be created from
// object types" even though it is a perfectly good stand-in for RoutineEnv at
// runtime.
const ENV = {
  PROVIDER_KEY_SECRET: SECRET,
  SUPABASE_URL: "https://example.test",
  SUPABASE_SERVICE_ROLE_KEY: "service",
} as unknown as RoutineEnv;

describe("readWorkspaceKeys", () => {
  it("returns the decrypted key", async () => {
    const sealed = await encryptSecret(SECRET, "sk-proj-real");
    currentDb = dbReturning({
      openai_ciphertext: sealed.ciphertext,
      openai_iv: sealed.iv,
      anthropic_ciphertext: null,
      anthropic_iv: null,
    });

    await expect(readWorkspaceKeys(ENV, "ws-1")).resolves.toEqual({
      openai: "sk-proj-real",
      anthropic: null,
    });
  });

  it("returns nothing when there is no row", async () => {
    currentDb = dbReturning(null);
    await expect(readWorkspaceKeys(ENV, "ws-1")).resolves.toEqual({
      openai: null,
      anthropic: null,
    });
  });

  it("returns nothing, and does not throw, when the read fails", async () => {
    currentDb = dbReturning(null, { message: "boom" });
    await expect(readWorkspaceKeys(ENV, "ws-1")).resolves.toEqual({
      openai: null,
      anthropic: null,
    });
  });

  it("returns nothing when PROVIDER_KEY_SECRET is unset", async () => {
    const sealed = await encryptSecret(SECRET, "sk-proj-real");
    currentDb = dbReturning({
      openai_ciphertext: sealed.ciphertext,
      openai_iv: sealed.iv,
      anthropic_ciphertext: null,
      anthropic_iv: null,
    });

    await expect(
      readWorkspaceKeys({ ...ENV, PROVIDER_KEY_SECRET: undefined }, "ws-1"),
    ).resolves.toEqual({ openai: null, anthropic: null });
  });

  it("returns nothing for a key the secret cannot open", async () => {
    currentDb = dbReturning({
      openai_ciphertext: "bm90LXJlYWw=",
      openai_iv: "MTIzNDU2Nzg5MDEy",
      anthropic_ciphertext: null,
      anthropic_iv: null,
    });

    await expect(readWorkspaceKeys(ENV, "ws-1")).resolves.toEqual({
      openai: null,
      anthropic: null,
    });
  });
});

describe("readKeyHints", () => {
  it("never reads a ciphertext column", async () => {
    currentDb = dbReturning({
      openai_hint: "sk-…4f2a",
      anthropic_hint: null,
      updated_at: "2026-09-05T00:00:00.000Z",
    });

    await expect(readKeyHints(ENV, "ws-1")).resolves.toEqual({
      openai: "sk-…4f2a",
      anthropic: null,
      updatedAt: "2026-09-05T00:00:00.000Z",
    });

    // The column list is the guard: a hint reader that selects '*' is one
    // refactor away from returning a key.
    const selected = currentDb.chain.select.mock.calls[0][0] as string;
    expect(selected).not.toContain("ciphertext");
    expect(selected).not.toContain("*");
  });
});

describe("writeWorkspaceKey", () => {
  it("stores ciphertext, iv and hint together and never the key", async () => {
    currentDb = dbReturning(null);
    await writeWorkspaceKey(ENV, "ws-1", "openai", "sk-proj-abcdef123456", "user-1");

    const row = currentDb.chain.upsert.mock.calls[0][0] as Record<string, string>;
    expect(row.openai_hint).toBe("sk-…3456");
    expect(row.openai_ciphertext).toBeTruthy();
    expect(row.openai_iv).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("sk-proj-abcdef123456");
  });

  it("refuses when PROVIDER_KEY_SECRET is unset", async () => {
    currentDb = dbReturning(null);
    await expect(
      writeWorkspaceKey({ ...ENV, PROVIDER_KEY_SECRET: undefined }, "ws-1", "openai", "sk-x", "u"),
    ).rejects.toThrow(/PROVIDER_KEY_SECRET/);
  });
});

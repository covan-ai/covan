import { describe, it, expect, vi, beforeEach } from "vitest";

import { keysForUser, withProviderKeys, type ProviderEnv } from "./resolve";

const readWorkspaceKeys = vi.fn();
const getActiveWorkspaceId = vi.fn();

vi.mock("./store", () => ({ readWorkspaceKeys: (...a: unknown[]) => readWorkspaceKeys(...a) }));
vi.mock("../workspace", () => ({
  getActiveWorkspaceId: (...a: unknown[]) => getActiveWorkspaceId(...a),
}));

const ENV = { OPENAI_API_KEY: "house-openai", ANTHROPIC_API_KEY: "house-anthropic" } as never;
const DB = {} as never;

beforeEach(() => {
  readWorkspaceKeys.mockReset();
  getActiveWorkspaceId.mockReset();
});

describe("keysForUser", () => {
  it("uses the operator's keys while the caller is within their allowance", async () => {
    await expect(keysForUser(ENV, DB, "u1", true)).resolves.toEqual({
      openai: "house-openai",
      anthropic: "house-anthropic",
      source: "house",
    });
    // No lookup at all — the common path costs nothing.
    expect(getActiveWorkspaceId).not.toHaveBeenCalled();
    expect(readWorkspaceKeys).not.toHaveBeenCalled();
  });

  it("uses the workspace key once the caller is out", async () => {
    getActiveWorkspaceId.mockResolvedValue("ws-1");
    readWorkspaceKeys.mockResolvedValue({ openai: "ws-openai", anthropic: null });

    await expect(keysForUser(ENV, DB, "u1", false)).resolves.toEqual({
      openai: "ws-openai",
      anthropic: undefined,
      source: "workspace",
    });
  });

  it("carries a workspace Anthropic key when one is set", async () => {
    getActiveWorkspaceId.mockResolvedValue("ws-1");
    readWorkspaceKeys.mockResolvedValue({ openai: "ws-openai", anthropic: "ws-anthropic" });

    await expect(keysForUser(ENV, DB, "u1", false)).resolves.toEqual({
      openai: "ws-openai",
      anthropic: "ws-anthropic",
      source: "workspace",
    });
  });

  it("stays on the operator's keys when the workspace has an Anthropic key but no OpenAI one", async () => {
    // OpenAI is the key that answers everything: embeddings, transcription and
    // the default model all need it. An Anthropic key alone cannot carry a
    // workspace past its allowance, so it does not try.
    getActiveWorkspaceId.mockResolvedValue("ws-1");
    readWorkspaceKeys.mockResolvedValue({ openai: null, anthropic: "ws-anthropic" });

    await expect(keysForUser(ENV, DB, "u1", false)).resolves.toEqual({
      openai: "house-openai",
      anthropic: "house-anthropic",
      source: "house",
    });
  });

  it("stays on the operator's keys when the workspace has none", async () => {
    getActiveWorkspaceId.mockResolvedValue("ws-1");
    readWorkspaceKeys.mockResolvedValue({ openai: null, anthropic: null });

    const keys = await keysForUser(ENV, DB, "u1", false);
    expect(keys.source).toBe("house");
  });

  it("stays on the operator's keys when the caller has no workspace", async () => {
    getActiveWorkspaceId.mockResolvedValue(null);

    const keys = await keysForUser(ENV, DB, "u1", false);
    expect(keys.source).toBe("house");
    expect(readWorkspaceKeys).not.toHaveBeenCalled();
  });

  it("falls back rather than throwing when the lookup fails", async () => {
    getActiveWorkspaceId.mockRejectedValue(new Error("boom"));

    const keys = await keysForUser(ENV, DB, "u1", false);
    expect(keys.source).toBe("house");
  });
});

describe("withProviderKeys", () => {
  it("replaces both keys and leaves everything else alone", () => {
    const env = { OPENAI_API_KEY: "house", ANTHROPIC_API_KEY: "house-a", SOMETHING: "kept" };
    const out = withProviderKeys(env as never, {
      openai: "ws",
      anthropic: "ws-a",
      source: "workspace",
    });

    expect(out).toEqual({ OPENAI_API_KEY: "ws", ANTHROPIC_API_KEY: "ws-a", SOMETHING: "kept" });
    // A copy, not a mutation: the operator's env is shared across the isolate.
    expect(env.OPENAI_API_KEY).toBe("house");
  });

  it("clears the Anthropic key when the workspace has not set one", () => {
    // This is what makes a Claude agent fall back to gpt-4o under a workspace
    // key: `resolveModel` already drops a Claude pick when there is no key for
    // it. No new fallback code exists anywhere.
    const out = withProviderKeys(
      { OPENAI_API_KEY: "house", ANTHROPIC_API_KEY: "house-a" } as unknown as ProviderEnv,
      { openai: "ws", anthropic: undefined, source: "workspace" },
    );

    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

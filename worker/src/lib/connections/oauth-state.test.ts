import { describe, it, expect } from "vitest";
import { readState, signState } from "./oauth-state";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const state = {
  provider: "notion" as const,
  userId: "user-1",
  workspaceId: "ws-1",
  bundleId: "bundle-1",
};

describe("oauth state", () => {
  it("round-trips who a grant belongs to", async () => {
    const raw = await signState(state, KEY);
    expect(await readState(raw, KEY)).toMatchObject(state);
  });

  it("survives being carried in a query string", async () => {
    const raw = await signState(state, KEY);
    // Providers echo `state` back verbatim. A value that needed percent-decoding
    // to survive would come back as a different string on the provider that
    // decodes and the provider that does not.
    const round = new URL(`https://api.example.com/cb?state=${encodeURIComponent(raw)}`);
    expect(await readState(round.searchParams.get("state")!, KEY)).toMatchObject(state);
    expect(raw).not.toMatch(/[+/]/);
  });

  // This is the CSRF property. A state nobody could forge is what stands in for
  // the bearer token the callback cannot have.
  it("refuses a state it did not issue", async () => {
    const raw = await signState(state, KEY);
    const [version, iv, ct] = raw.split(".");
    const flipped = ct[0] === "A" ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
    expect(await readState(`${version}.${iv}.${flipped}`, KEY)).toBeNull();
    expect(await readState("not-a-state", KEY)).toBeNull();
    expect(await readState("", KEY)).toBeNull();
  });

  it("refuses a state signed with another install's key", async () => {
    const other = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    expect(await readState(await signState(state, other), KEY)).toBeNull();
  });

  it("expires, so a captured redirect stops working", async () => {
    const issued = Date.parse("2026-09-02T10:00:00Z");
    const raw = await signState(state, KEY, issued);

    expect(await readState(raw, KEY, issued + 9 * 60_000)).toMatchObject(state);
    expect(await readState(raw, KEY, issued + 11 * 60_000)).toBeNull();
  });

  // An `issuedAt` in the future is what a replay from a machine with a wrong
  // clock looks like, and treating it as fresh would make the expiry above
  // meaningless.
  it("refuses a state issued in the future", async () => {
    const now = Date.parse("2026-09-02T10:00:00Z");
    const raw = await signState(state, KEY, now + 10 * 60_000);
    expect(await readState(raw, KEY, now)).toBeNull();
  });

  it("refuses a state that decrypts but names nothing", async () => {
    // Encrypted with our key, so it decrypts — and still is not a state.
    const { encryptSecret } = await import("../secret-box");
    const raw = await encryptSecret(JSON.stringify({ issuedAt: Date.now() }), KEY);
    expect(await readState(raw, KEY)).toBeNull();
  });
});

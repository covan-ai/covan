import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasPendingGrant, takePendingGrant, takeSensitiveParams } from "./sensitive-url";
import { beginFlow, endFlow, flowNonce, sha256Hex } from "./flow-nonce";

/**
 * A connect flow comes back with the one thing that finishes it in the
 * address bar. It is moved out of the URL before anything else reads it, kept
 * in this tab, and finished at most once.
 */
beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("takeSensitiveParams", () => {
  it("moves a grant out of the address bar and keeps harmless parameters", async () => {
    window.history.replaceState(null, "", "/integrations?grant=sealed-g&for=connection&error=x");

    takeSensitiveParams();

    expect(window.location.search).toBe("?error=x");
    expect(hasPendingGrant()).toBe(true);
    expect(takePendingGrant()).toEqual({ kind: "oauth", grant: "sealed-g", for: "connection" });
  });

  it("keeps a connected application's nonce the same way", () => {
    window.history.replaceState(null, "", "/integrations?composio=gmail&nonce=n-1");

    takeSensitiveParams();

    expect(window.location.search).toBe("");
    expect(takePendingGrant()).toEqual({ kind: "composio", toolkit: "gmail", nonce: "n-1" });
  });

  it("hands a grant over once, so it is finished at most once", () => {
    window.history.replaceState(null, "", "/integrations?grant=g&for=slack");
    takeSensitiveParams();

    expect(takePendingGrant()).not.toBeNull();
    expect(takePendingGrant()).toBeNull();
    expect(hasPendingGrant()).toBe(false);
  });

  it("leaves a page with nothing sensitive alone", () => {
    window.history.replaceState(null, "", "/agents?tab=x");
    takeSensitiveParams();
    expect(window.location.search).toBe("?tab=x");
    expect(hasPendingGrant()).toBe(false);
  });
});

describe("the flow nonce", () => {
  it("keeps the nonce in this tab and sends only its hash", async () => {
    const hash = await beginFlow();
    const nonce = flowNonce()!;

    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(await sha256Hex(nonce));
    expect(hash).not.toContain(nonce);

    endFlow();
    expect(flowNonce()).toBeNull();
  });
});

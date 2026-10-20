import { afterEach, describe, expect, it, vi } from "vitest";
import { enabledProviders } from "./providers";

function answer(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body })),
  );
}

describe("enabledProviders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers the providers GoTrue reports on, in the cards' order", async () => {
    answer({ external: { github: true, google: true, apple: true, email: true } });
    expect(await enabledProviders()).toEqual(["google", "github"]);
  });

  it("leaves out a provider GoTrue reports off", async () => {
    answer({ external: { google: false, github: true } });
    expect(await enabledProviders()).toEqual(["github"]);
  });

  // A button for a provider GoTrue has not switched on answers its click with
  // GoTrue's JSON error page, and that page has no way back to the form.
  it("offers nothing when the lookup fails", async () => {
    answer({}, false);
    expect(await enabledProviders()).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect(await enabledProviders()).toEqual([]);
  });

  it("does not take a truthy string for a yes", async () => {
    answer({ external: { google: "true" } });
    expect(await enabledProviders()).toEqual([]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { stashReturn, takeReturn } from "./return-stash";

const REQUEST = "/approvals/4b1f7c0e-2d7a-4c55-9b7e-0d6a1f3e9c21";

beforeEach(() => localStorage.clear());

describe("the page to come back to after signing in", () => {
  it("hands back a request's page once", () => {
    stashReturn(REQUEST, 1_000);
    expect(takeReturn(2_000)).toBe(REQUEST);
    expect(takeReturn(3_000)).toBeNull();
  });

  it("keeps nothing but a request's page", () => {
    for (const path of ["/app", "/settings/api-keys", "/approvals/not-an-id", "//evil.test"]) {
      stashReturn(path, 1_000);
      expect(takeReturn(2_000), path).toBeNull();
    }
  });

  it("forgets it after a day, as the request does", () => {
    stashReturn(REQUEST, 0);
    expect(takeReturn(24 * 60 * 60 * 1000 + 1)).toBeNull();
  });
});

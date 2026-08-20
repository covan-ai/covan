import { describe, it, expect } from "vitest";
import { insertErrorStatus } from "./insert-error";

describe("insertErrorStatus", () => {
  it("maps an RLS/permission violation (42501) to 400", () => {
    expect(insertErrorStatus({ code: "42501" })).toBe(400);
  });

  it("maps any other Postgres error code to 500", () => {
    expect(insertErrorStatus({ code: "23503" })).toBe(500);
  });

  it("maps a missing code to 500", () => {
    expect(insertErrorStatus({})).toBe(500);
  });

  it("maps a null/undefined error to 500", () => {
    expect(insertErrorStatus(null)).toBe(500);
    expect(insertErrorStatus(undefined)).toBe(500);
  });
});

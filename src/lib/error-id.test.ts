import { describe, expect, it } from "vitest";
import { ApiError } from "./api-error";
import { errorIdOf } from "./error-id";

describe("an error's id", () => {
  it("comes from the request when the API said which", () => {
    const e = new ApiError(500, "boom", "8d3c2b1a0f9e8d7c-IST");
    expect(errorIdOf(e)).toBe("err_8d3c2b1a");
  });

  it("is eight letters of its own otherwise", () => {
    expect(errorIdOf(new Error("boom"))).toMatch(/^err_[a-z0-9]{8}$/);
  });
});

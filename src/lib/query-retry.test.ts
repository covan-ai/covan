import { describe, expect, it } from "vitest";
import { shouldRetryQuery } from "./query-retry";
import { ApiError } from "./api-error";

describe("shouldRetryQuery", () => {
  it("does not retry an answer the server already gave", () => {
    // The one measured on covan.app: five queries, four attempts each, on a
    // page nobody had signed in to.
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(shouldRetryQuery(0, new ApiError(status, "no")), `${status}`).toBe(false);
    }
  });

  it("retries the two 4xx that mean later", () => {
    expect(shouldRetryQuery(0, new ApiError(408, "timeout"))).toBe(true);
    expect(shouldRetryQuery(0, new ApiError(429, "slow down"))).toBe(true);
  });

  it("retries a server error and a dropped connection", () => {
    expect(shouldRetryQuery(0, new ApiError(500, "boom"))).toBe(true);
    expect(shouldRetryQuery(0, new ApiError(503, "away"))).toBe(true);
    // Not an ApiError at all: a network failure never reached a server, which
    // is the case retrying was written for.
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
  });

  it("still stops after react-query's usual number of attempts", () => {
    expect(shouldRetryQuery(2, new ApiError(500, "boom"))).toBe(true);
    expect(shouldRetryQuery(3, new ApiError(500, "boom"))).toBe(false);
    expect(shouldRetryQuery(3, new TypeError("Failed to fetch"))).toBe(false);
  });
});

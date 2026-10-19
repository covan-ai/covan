import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyProviderError,
  explainProviderFailure,
  isProviderError,
  registerProviderFailureObserver,
  reportProviderFailure,
  resetProviderFailureObserver,
} from "./provider-error";
import type { RoutineEnv } from "../types";

/** The shape both SDKs throw: an Error with `status`, `requestID` and a body. */
function apiError(
  status: number | undefined,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return Object.assign(new Error(message), { status, requestID: "req_1" }, extra);
}

const env = {} as RoutineEnv;

describe("classifyProviderError", () => {
  it("reads OpenAI's empty account as quota, not a rate limit — both are 429", () => {
    // Measured on 2026-10-17, the day this file exists because of.
    const err = apiError(429, "429 You exceeded your current quota", {
      code: "insufficient_quota",
      type: "insufficient_quota",
    });
    expect(classifyProviderError(err, "openai")).toMatchObject({
      kind: "quota",
      provider: "openai",
      retryable: false,
      status: 429,
    });
  });

  it("reads the words when there is no code", () => {
    const err = apiError(429, "429 You have no credits remaining");
    expect(classifyProviderError(err).kind).toBe("quota");
  });

  it("reads Anthropic's empty balance, which arrives as a 400", () => {
    const err = apiError(
      400,
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.",
      { error: { type: "error", error: { type: "invalid_request_error" } } },
    );
    expect(classifyProviderError(err, "anthropic")).toMatchObject({
      kind: "quota",
      retryable: false,
    });
  });

  it("reads a revoked or wrong key as the operator's", () => {
    expect(classifyProviderError(apiError(401, "Incorrect API key provided")).kind).toBe("auth");
    expect(classifyProviderError(apiError(403, "Forbidden")).kind).toBe("auth");
    expect(
      classifyProviderError(apiError(undefined, "bad key", { code: "invalid_api_key" })).kind,
    ).toBe("auth");
  });

  it("reads a rate limit, an outage and a timeout as worth another try", () => {
    expect(classifyProviderError(apiError(429, "Rate limit reached for gpt-5"))).toMatchObject({
      kind: "rate",
      retryable: true,
    });
    expect(classifyProviderError(apiError(529, "Overloaded")).kind).toBe("server");
    expect(classifyProviderError(apiError(500, "Internal error")).kind).toBe("server");
    const timeout = Object.assign(new Error("Request timed out."), {
      name: "APIConnectionTimeoutError",
    });
    expect(classifyProviderError(timeout)).toMatchObject({ kind: "timeout", retryable: true });
  });

  it("leaves what it cannot place as unknown, and retryable — how every error was treated before", () => {
    expect(classifyProviderError(new Error("relation does not exist"))).toMatchObject({
      kind: "unknown",
      retryable: true,
      status: null,
    });
    expect(classifyProviderError("a string")).toMatchObject({ kind: "unknown" });
    expect(classifyProviderError(null).kind).toBe("unknown");
  });

  it("does not read 'billing' in an error that never reached a provider", () => {
    // No status: a message of our own that happens to say the word.
    expect(classifyProviderError(new Error("billing table missing")).kind).toBe("unknown");
  });
});

describe("isProviderError", () => {
  it("knows an SDK error by its request id, and a connection failure by its name", () => {
    expect(isProviderError(apiError(429, "x"))).toBe(true);
    expect(isProviderError(Object.assign(new Error("x"), { name: "APIConnectionError" }))).toBe(
      true,
    );
  });

  it("does not mistake a feed's 403 for the model's", () => {
    expect(isProviderError(Object.assign(new Error("upstream 403"), { status: 403 }))).toBe(false);
    expect(isProviderError(new Error("x"))).toBe(false);
    expect(isProviderError(undefined)).toBe(false);
  });
});

describe("explainProviderFailure", () => {
  it("does not tell the person to try again when trying again cannot help", () => {
    const sentence = explainProviderFailure(classifyProviderError(apiError(401, "bad key")));
    expect(sentence).toContain("unavailable");
    expect(sentence).not.toContain("Please try again");
  });

  it("does, when it can", () => {
    expect(explainProviderFailure(classifyProviderError(apiError(503, "x")))).toContain(
      "Please try again",
    );
  });
});

describe("reportProviderFailure", () => {
  afterEach(() => resetProviderFailureObserver());

  it("tells the observer about the operator's problems only", async () => {
    const observed = vi.fn(async () => {});
    registerProviderFailureObserver(observed);
    await reportProviderFailure(env, classifyProviderError(apiError(503, "x")));
    expect(observed).not.toHaveBeenCalled();
    const quota = classifyProviderError(apiError(429, "x", { code: "insufficient_quota" }));
    await reportProviderFailure(env, quota);
    expect(observed).toHaveBeenCalledWith(env, quota);
  });

  it("never throws, because it runs on a path already reporting a failure", async () => {
    registerProviderFailureObserver(async () => {
      throw new Error("mail is down too");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      reportProviderFailure(env, classifyProviderError(apiError(401, "x"))),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("does nothing on the open build, where nothing is registered", async () => {
    await expect(
      reportProviderFailure(env, classifyProviderError(apiError(401, "x"))),
    ).resolves.toBeUndefined();
  });
});

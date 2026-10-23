import { describe, it, expect } from "vitest";
import { ApiError, errorMessage, statedError } from "./api-error";

describe("errorMessage", () => {
  it("passes the server's own sentence through", () => {
    expect(errorMessage(502, { error: "could not transcribe the recording" }, "Bad Gateway")).toBe(
      "could not transcribe the recording",
    );
  });

  it("falls back to the status when the body says nothing useful", () => {
    expect(errorMessage(500, {}, "Internal Server Error")).toBe("Internal Server Error");
    expect(errorMessage(500, null, "Internal Server Error")).toBe("Internal Server Error");
  });

  // 402 is the one refusal with a machine-readable shape, and its `error` field
  // is a code rather than a sentence. Every caller — dictation, upload, persona,
  // routine draft — has to report it the same way without knowing about credits.
  it("turns a credits refusal into a sentence", () => {
    const message = errorMessage(
      402,
      { error: "credits_exhausted", balance: -0.3 },
      "Payment Required",
    );

    expect(message).toBe(
      "This workspace is out of credits. An admin can ask for more from Settings.",
    );
  });

  it("never offers a key of the workspace's own, which no longer exists", () => {
    const message = errorMessage(402, { error: "credits_exhausted" }, "Payment Required");
    expect(message).not.toMatch(/own key/);
  });

  it("leaves a 402 that is not about credits alone", () => {
    expect(errorMessage(402, { error: "card declined" }, "Payment Required")).toBe("card declined");
  });

  it("turns the other codes into sentences too", () => {
    expect(errorMessage(429, { error: "rate_limited" }, "Too Many Requests")).toBe(
      "Too many requests. Wait a moment and try again.",
    );
    expect(errorMessage(403, { error: "not_yours" }, "Forbidden")).toBe(
      "This isn't yours to change.",
    );
    expect(errorMessage(500, { error: "save_failed" }, "Internal Server Error")).toBe(
      "Couldn't save. Try again.",
    );
  });

  // The API speaks English. On a Turkish page its sentence would be the one
  // English line in a Turkish toast, so the caller's own words are shown and
  // the server's are kept on the error as `detail`.
  it("shows the caller's fallback instead of the server's English on a Turkish page", () => {
    expect(
      errorMessage(404, { error: "no workspace found for user" }, "Fallback sentence", "tr"),
    ).toBe("Fallback sentence");
    expect(errorMessage(500, {}, "Fallback sentence", "tr")).toBe("Fallback sentence");
  });

  it("still turns a code into a sentence on a Turkish page", () => {
    expect(errorMessage(402, { error: "credits_exhausted" }, "Fallback", "tr")).not.toBe(
      "Fallback",
    );
  });
});

describe("statedError", () => {
  it("reads the error string and nothing else", () => {
    expect(statedError({ error: "not found" })).toBe("not found");
    expect(statedError({ error: 404 })).toBeNull();
    expect(statedError(null)).toBeNull();
    expect(statedError("not found")).toBeNull();
  });
});

describe("ApiError", () => {
  it("keeps the server's words apart from the shown ones", () => {
    const error = new ApiError(404, "Shown", "req-1", "no workspace found for user");
    expect(error.message).toBe("Shown");
    expect(error.detail).toBe("no workspace found for user");
    expect(error.requestId).toBe("req-1");
  });

  it("does not repeat the message as detail", () => {
    expect(new ApiError(404, "not found", undefined, "not found").detail).toBeUndefined();
  });
});

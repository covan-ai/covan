import { describe, it, expect } from "vitest";
import { errorMessage } from "./api-error";

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
  // routine draft — has to report it the same way without knowing about quotas.
  it("turns a quota refusal into a sentence, with the date it lifts", () => {
    const message = errorMessage(
      402,
      { error: "quota_exceeded", used: 1200, limit: 1000, resetsAt: "2026-09-01T00:00:00.000Z" },
      "Payment Required",
    );

    expect(message).toContain("You've used this month's allowance");
    expect(message).toContain("September 1");
  });

  it("still says what happened when there is no date to give", () => {
    const message = errorMessage(402, { error: "quota_exceeded" }, "Payment Required");

    expect(message).toBe("You've used this month's allowance.");
  });

  it("leaves a 402 that is not about quota alone", () => {
    expect(errorMessage(402, { error: "card declined" }, "Payment Required")).toBe("card declined");
  });
});

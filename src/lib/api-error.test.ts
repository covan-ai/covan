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
});

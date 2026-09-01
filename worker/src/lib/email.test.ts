import { describe, expect, it, vi } from "vitest";
import { sendEmail } from "./email";

/**
 * What Resend is actually asked for.
 *
 * The HTML half exists so a mail can look like the product; the text half stays
 * because a client that strips styles has to be left with something to read.
 * Both go in one request, so these tests read the request body rather than
 * asserting that a mock was called.
 */
function captureRequest() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const DEPS = { apiKey: "re_test", from: "Covan <no-reply@mail.covan.app>" };

describe("sendEmail", () => {
  it("sends the HTML part alongside the text one", async () => {
    const { calls, fetchImpl } = captureRequest();

    await sendEmail(
      {
        to: "someone@example.com",
        subject: "Subject",
        text: "The plain text half.",
        html: "<p>The HTML half.</p>",
      },
      { ...DEPS, fetchImpl },
    );

    expect(calls[0].body.text).toBe("The plain text half.");
    expect(calls[0].body.html).toBe("<p>The HTML half.</p>");
  });

  // Not the same as sending `html: null`. A caller with nothing to style has to
  // produce the request it produced before this field existed, or every
  // text-only mail starts depending on how Resend reads an empty HTML body.
  it("omits the HTML key entirely when there is no HTML", async () => {
    const { calls, fetchImpl } = captureRequest();

    await sendEmail(
      { to: "someone@example.com", subject: "Subject", text: "Text only." },
      { ...DEPS, fetchImpl },
    );

    expect(calls[0].body).not.toHaveProperty("html");
  });
});

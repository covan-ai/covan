import { describe, expect, it, vi } from "vitest";
import { lookupEmail, postMessage } from "./api";

function slack(answer: Record<string, unknown>) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(answer));
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

describe("slack web api calls", () => {
  // Slack ignores a JSON body on its read methods, so `user` never arrived and
  // users.info answered user_not_found for everybody who asked in Slack.
  it("posts a read method's arguments as a form Slack reads", async () => {
    const { sent, fetchImpl } = slack({ ok: true, user: { profile: { email: "Ayse@Acme.com" } } });
    expect(await lookupEmail(fetchImpl, "xoxb-1", "U9")).toBe("ayse@acme.com");
    const { url, init } = sent[0];
    expect(url).toBe("https://slack.com/api/users.info");
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer xoxb-1");
    expect(String(init.body)).toBe("user=U9");
  });

  it("posts a write the same way, flags as words", async () => {
    const { sent, fetchImpl } = slack({ ok: true });
    await postMessage(fetchImpl, "xoxb-1", { channel: "C1", threadTs: "1.0", text: "a & b" });
    const form = new URLSearchParams(String(sent[0].init.body));
    expect(Object.fromEntries(form)).toEqual({
      channel: "C1",
      thread_ts: "1.0",
      text: "a & b",
      unfurl_links: "false",
      unfurl_media: "false",
    });
  });

  it("treats a user Slack cannot find as nobody, not as a failure", async () => {
    const { fetchImpl } = slack({ ok: false, error: "user_not_found" });
    expect(await lookupEmail(fetchImpl, "xoxb-1", "U9")).toBeNull();
  });
});

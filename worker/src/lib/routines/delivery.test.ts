import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { deliver, claimItemKeys, releaseItemKeys } from "./delivery";
import { UpstreamError } from "./upstream-error";
import { encryptSecret } from "../secret-box";
import { serialiseWebhookSecret, EVENT_TEST } from "./webhook";

// The webhook branch runs the resolving half of the URL guard before it sends,
// which on Node is a dynamic `import("node:dns/promises")`. Stubbed for the
// same reason source.test.ts stubs it: these tests are about what gets POSTed,
// not about what example.com resolves to today.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const resolvesTo = (address: string) =>
  vi.mocked(lookup).mockResolvedValue([{ address, family: 4 }] as never);

beforeEach(() => resolvesTo("93.184.216.34"));

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ok = () => new Response("{}", { status: 200 });

const deps = (fetchImpl: any, over: Record<string, unknown> = {}) => ({
  fetchImpl: fetchImpl as typeof fetch,
  secretKey: KEY,
  resendApiKey: "re_test",
  resendFrom: "Routines <routines@example.com>",
  ownHosts: ["api.example.com"],
  ...over,
});

describe("deliver", () => {
  it("posts the body to the decrypted slack webhook", async () => {
    const fetchImpl = vi.fn(ok);
    const channel = {
      kind: "slack_webhook" as const,
      secret_ciphertext: await encryptSecret(
        "https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE",
        KEY,
      ),
    };
    await deliver(channel, { subject: "r/saas", body: "3 new posts" }, deps(fetchImpl));

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).text).toContain("3 new posts");
  });

  it("sends email through resend with the configured sender", async () => {
    const fetchImpl = vi.fn(ok);
    const channel = {
      kind: "email" as const,
      secret_ciphertext: await encryptSecret("deniz@example.com", KEY),
    };
    await deliver(channel, { subject: "r/saas", body: "3 new posts" }, deps(fetchImpl));

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("https://api.resend.com/emails");
    expect(headers.Authorization).toBe("Bearer re_test");
    const payload = JSON.parse(init.body as string);
    expect(payload.to).toEqual(["deniz@example.com"]);
    expect(payload.from).toBe("Routines <routines@example.com>");
    expect(payload.subject).toBe("r/saas");
  });

  // The summary is whatever the model wrote, and models write Markdown. Until
  // this was rendered, a digest arrived with its asterisks and dashes intact —
  // the routine's own output looked like a draft of itself.
  it("renders the summary's markdown into the HTML half", async () => {
    const fetchImpl = vi.fn(ok);
    const channel = {
      kind: "email" as const,
      secret_ciphertext: await encryptSecret("deniz@example.com", KEY),
    };
    await deliver(
      channel,
      { subject: "r/saas", body: "## Today\n\n- **Pricing** changed\n- Nothing else" },
      deps(fetchImpl),
    );

    const payload = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(payload.html).toContain("<strong>Pricing</strong>");
    expect(payload.html).toContain("<li");
    expect(payload.html).not.toContain("##");
    // The text half stays the summary exactly as the model wrote it.
    expect(payload.text).toBe("## Today\n\n- **Pricing** changed\n- Nothing else");
  });

  // Slack renders its own markup from the text field and has no HTML half to
  // send, so the rendering above must not follow the message down this path.
  it("leaves the slack payload as text", async () => {
    const fetchImpl = vi.fn(ok);
    const channel = {
      kind: "slack_webhook" as const,
      secret_ciphertext: await encryptSecret("https://hooks.slack.com/services/E/E/E", KEY),
    };
    await deliver(channel, { subject: "r/saas", body: "**bold**" }, deps(fetchImpl));

    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).not.toHaveProperty("html");
    expect(body.text).toContain("**bold**");
  });

  it("throws when the channel rejects the message", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid_token", { status: 403 }));
    const channel = {
      kind: "slack_webhook" as const,
      secret_ciphertext: await encryptSecret(
        "https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE",
        KEY,
      ),
    };
    await expect(deliver(channel, { subject: "s", body: "b" }, deps(fetchImpl))).rejects.toThrow(
      /delivery failed: 403/,
    );
  });
});

describe("deliver, to a webhook", () => {
  const SIGNING_SECRET = "whsec_TEST";
  const SENT_AT = new Date("2026-09-20T09:00:00.000Z");
  const TS = Math.floor(SENT_AT.getTime() / 1000);

  const channelFor = async (url: string) => ({
    kind: "webhook" as const,
    secret_ciphertext: await encryptSecret(
      serialiseWebhookSecret({ url, signingSecret: SIGNING_SECRET }),
      KEY,
    ),
  });

  const webhookDeps = (fetchImpl: any) => deps(fetchImpl, { now: () => SENT_AT });

  const sent = (fetchImpl: any) =>
    fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];

  const context = {
    event: "routine.delivered",
    routine: { id: "r-1", name: "Weekly digest", agentId: "a-1" },
    run: { itemsNew: 3, itemsOverflow: 1, triggeredBy: "schedule" },
  };

  it("posts the versioned payload with the run attached", async () => {
    const fetchImpl = vi.fn(ok);
    await deliver(
      await channelFor("https://receiver.example.com/covan"),
      { subject: "Weekly digest", body: "3 new posts" },
      webhookDeps(fetchImpl),
      context,
    );

    const [url, init] = sent(fetchImpl);
    expect(url).toBe("https://receiver.example.com/covan");
    expect(init.method).toBe("POST");

    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({
      version: 1,
      event: "routine.delivered",
      sentAt: "2026-09-20T09:00:00.000Z",
      routine: { id: "r-1", name: "Weekly digest", agentId: "a-1" },
      run: { itemsNew: 3, itemsOverflow: 1, triggeredBy: "schedule" },
      subject: "Weekly digest",
      body: "3 new posts",
    });
    expect(payload.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  // `deliver` is called before `finish` writes the run row, so there is no run
  // id at this point. Sending one would mean inventing a number that the row
  // later disagrees with; what a receiver needs to deduplicate is the delivery.
  it("does not claim to know a run id", async () => {
    const fetchImpl = vi.fn(ok);
    await deliver(
      await channelFor("https://receiver.example.com/covan"),
      { subject: "s", body: "b" },
      webhookDeps(fetchImpl),
      context,
    );
    expect(JSON.parse(sent(fetchImpl)[1].body as string).run).not.toHaveProperty("id");
  });

  it("gives every delivery its own id", async () => {
    const fetchImpl = vi.fn(ok);
    const channel = await channelFor("https://receiver.example.com/covan");
    await deliver(channel, { subject: "s", body: "b" }, webhookDeps(fetchImpl), context);
    await deliver(channel, { subject: "s", body: "b" }, webhookDeps(fetchImpl), context);

    const ids = fetchImpl.mock.calls.map(
      (call: any) => JSON.parse(call[1].body as string).deliveryId,
    );
    expect(ids[0]).not.toBe(ids[1]);
    const headers = fetchImpl.mock.calls.map((call: any) => call[1].headers["X-Covan-Delivery"]);
    expect(headers).toEqual(ids);
  });

  // The interoperability claim: a receiver verifies with its own library over
  // the bytes it received. Computed here with node:crypto rather than with the
  // module under test, which would agree with itself whatever it did.
  it("signs exactly the bytes it sends, Slack's scheme with a v1", async () => {
    const fetchImpl = vi.fn(ok);
    await deliver(
      await channelFor("https://receiver.example.com/covan"),
      { subject: "Günaydın", body: "3 new posts" },
      webhookDeps(fetchImpl),
      context,
    );

    const [, init] = sent(fetchImpl);
    const raw = init.body as string;
    const expected = createHmac("sha256", SIGNING_SECRET)
      .update(`v1:${TS}:${raw}`, "utf8")
      .digest("hex");

    expect(init.headers["X-Covan-Signature"]).toBe(`v1=${expected}`);
    expect(init.headers["X-Covan-Timestamp"]).toBe(String(TS));
    expect(init.headers["X-Covan-Event"]).toBe("routine.delivered");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("signs with this channel's secret and no other", async () => {
    const fetchImpl = vi.fn(ok);
    await deliver(
      await channelFor("https://receiver.example.com/covan"),
      { subject: "s", body: "b" },
      webhookDeps(fetchImpl),
      context,
    );

    const [, init] = sent(fetchImpl);
    const wrong = createHmac("sha256", "whsec_SOMEBODY_ELSE")
      .update(`v1:${TS}:${init.body as string}`, "utf8")
      .digest("hex");
    expect(init.headers["X-Covan-Signature"]).not.toBe(`v1=${wrong}`);
  });

  it("sends a test event with no routine block", async () => {
    const fetchImpl = vi.fn(ok);
    await deliver(
      await channelFor("https://receiver.example.com/covan"),
      { subject: "Test", body: "A test delivery." },
      webhookDeps(fetchImpl),
      { event: EVENT_TEST },
    );

    const payload = JSON.parse(sent(fetchImpl)[1].body as string);
    expect(payload.event).toBe("routine.test");
    expect(payload).not.toHaveProperty("routine");
    expect(payload).not.toHaveProperty("run");
  });

  // A POST is not idempotent. Following a redirect either replays a signed body
  // at a host the signature does not name, or drops the body and sends a GET.
  it.each([301, 302, 307, 308])("refuses to follow a %i", async (status) => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status, headers: { Location: "https://elsewhere.test/" } }),
    );
    await expect(
      deliver(
        await channelFor("https://receiver.example.com/covan"),
        { subject: "s", body: "b" },
        webhookDeps(fetchImpl),
        context,
      ),
    ).rejects.toThrow(/not followed/);

    expect((fetchImpl.mock.calls[0] as any)[1].redirect).toBe("manual");
  });

  // The whole point of the split: a receiver's bad afternoon must not pause a
  // working routine, and a receiver's wrong URL must not be retried twenty
  // times. `transient` is what executor.ts reads to tell them apart.
  it.each([429, 500, 503])("reports %i as the remote's fault", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("slow down", { status }));
    const err = await deliver(
      await channelFor("https://receiver.example.com/covan"),
      { subject: "s", body: "b" },
      webhookDeps(fetchImpl),
      context,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.transient).toBe(true);
    // What the receiver said still reaches routine_runs.error.
    expect(err.message).toContain("slow down");
  });

  it.each([400, 401, 404, 410])("reports %i as this channel's fault", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("no such hook", { status }));
    const err = await deliver(
      await channelFor("https://receiver.example.com/covan"),
      { subject: "s", body: "b" },
      webhookDeps(fetchImpl),
      context,
    ).catch((e) => e);

    expect(err).not.toBeInstanceOf(UpstreamError);
    expect(err.message).toMatch(/delivery failed: \d+ no such hook/);
  });

  // Before the cap, this body was read to the end and then truncated to 200
  // characters — the memory was spent first and judged too much afterwards.
  it("stops reading a hostile error body instead of buffering it", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024).fill(65));
            },
          }),
          { status: 500 },
        ),
    );

    const err = await deliver(
      await channelFor("https://receiver.example.com/covan"),
      { subject: "s", body: "b" },
      webhookDeps(fetchImpl),
      context,
    ).catch((e) => e);

    // Still classified, still short: the status is what mattered and the body
    // was abandoned rather than collected.
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(500);
    expect(err.message.length).toBeLessThan(300);
  });

  // A channel outlives the DNS record it was created against. This is the only
  // check that catches a hostname which starts answering with a private
  // address after the fact, and it has to happen before the body is sent.
  it("refuses a host that now resolves into private space", async () => {
    resolvesTo("169.254.169.254");
    const fetchImpl = vi.fn(ok);

    await expect(
      deliver(
        await channelFor("https://receiver.example.com/covan"),
        { subject: "s", body: "b" },
        webhookDeps(fetchImpl),
        context,
      ),
    ).rejects.toThrow(/private address/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a channel pointed back at this service", async () => {
    const fetchImpl = vi.fn(ok);
    await expect(
      deliver(
        await channelFor("https://api.example.com/hook"),
        { subject: "s", body: "b" },
        webhookDeps(fetchImpl),
        context,
      ),
    ).rejects.toThrow(/this service/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a secret it cannot read rather than posting unsigned", async () => {
    const fetchImpl = vi.fn(ok);
    const channel = {
      kind: "webhook" as const,
      secret_ciphertext: await encryptSecret("https://receiver.example.com/covan", KEY),
    };
    await expect(
      deliver(channel, { subject: "s", body: "b" }, webhookDeps(fetchImpl), context),
    ).rejects.toThrow(/not readable/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("claimItemKeys", () => {
  it("returns only the keys it actually inserted", async () => {
    const upsert = vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue({ data: [{ item_key: "b" }], error: null }),
    });
    const db = { from: vi.fn().mockReturnValue({ upsert }) };

    const claimed = await claimItemKeys(db as any, "r1", ["a", "b"]);

    expect(claimed).toEqual(["b"]);
    expect(db.from).toHaveBeenCalledWith("routine_deliveries");
    expect(upsert.mock.calls[0][1]).toMatchObject({
      onConflict: "routine_id,item_key",
      ignoreDuplicates: true,
    });
  });

  it("propagates a database error rather than silently sending", async () => {
    const upsert = vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }),
    });
    const db = { from: vi.fn().mockReturnValue({ upsert }) };
    await expect(claimItemKeys(db as any, "r1", ["a"])).rejects.toThrow(/boom/);
  });
});

describe("releaseItemKeys", () => {
  it("deletes the claimed rows so a later run retries them", async () => {
    const inFn = vi.fn().mockResolvedValue({ error: null });
    const eq = vi.fn().mockReturnValue({ in: inFn });
    const del = vi.fn().mockReturnValue({ eq });
    const db = { from: vi.fn().mockReturnValue({ delete: del }) };

    await releaseItemKeys(db as any, "r1", ["a", "b"]);

    expect(eq).toHaveBeenCalledWith("routine_id", "r1");
    expect(inFn).toHaveBeenCalledWith("item_key", ["a", "b"]);
  });
});

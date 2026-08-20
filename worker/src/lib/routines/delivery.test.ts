import { describe, it, expect, vi } from "vitest";
import { deliver, claimItemKeys, releaseItemKeys } from "./delivery";
import { encryptSecret } from "./crypto";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ok = () => new Response("{}", { status: 200 });

const deps = (fetchImpl: any) => ({
  fetchImpl: fetchImpl as typeof fetch,
  secretKey: KEY,
  resendApiKey: "re_test",
  resendFrom: "Routines <routines@example.com>",
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

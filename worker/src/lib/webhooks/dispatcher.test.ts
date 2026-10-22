import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../secret-box";
import { signWebhookBody } from "../routines/webhook";
import {
  MAX_ATTEMPTS,
  dispatchWebhooks,
  sendDelivery,
  webhookBody,
  type DueDelivery,
  type WebhookDeps,
} from "./dispatcher";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-10-22T10:00:00Z");

async function due(over: Partial<DueDelivery> = {}): Promise<DueDelivery> {
  return {
    id: "d1",
    endpoint_id: "e1",
    workspace_id: "w1",
    event: "thread.finished",
    payload: { thread: { id: "s1", title: "Refund policy" } },
    attempt: 0,
    created_at: "2026-10-22T09:59:00Z",
    url: "https://hooks.acme.test/covan",
    secret_ciphertext: await encryptSecret("whsec_test", KEY),
    disabled_at: null,
    ...over,
  };
}

function deps(response: () => Response | Promise<Response>) {
  const writes: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => response());
  const db = {
    from: () => ({
      update: (values: Record<string, unknown>) => ({
        eq: async () => {
          writes.push(values);
          return { error: null };
        },
      }),
    }),
    rpc: vi.fn(),
  };
  const d: WebhookDeps = {
    db: db as never,
    fetchImpl: fetchImpl as never,
    secretKey: KEY,
    ownHosts: ["api.covan.test"],
    now: () => NOW,
  };
  return { d, writes, fetchImpl, db };
}

describe("one try", () => {
  it("signs the body it sends, and records a 2xx as delivered", async () => {
    const { d, writes, fetchImpl } = deps(() => new Response("ok", { status: 200 }));
    const row = await due();

    const out = await sendDelivery(row, d);

    expect(out).toMatchObject({ status: "ok", statusCode: 200 });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    expect(body).toBe(webhookBody(row, NOW));
    expect(JSON.parse(body)).toMatchObject({ event: "thread.finished", data: row.payload });
    expect(headers["X-Covan-Signature"]).toBe(
      await signWebhookBody("whsec_test", Math.floor(NOW.getTime() / 1000), body),
    );
    expect(writes[0]).toMatchObject({
      status: "ok",
      attempt: 1,
      status_code: 200,
      last_error: null,
    });
  });

  it("tries again later after a failure, and gives up after the last try", async () => {
    const first = deps(() => new Response("down", { status: 503 }));
    await sendDelivery(await due(), first.d);
    expect(first.writes[0]).toMatchObject({ status: "pending", attempt: 1, status_code: 503 });
    expect(first.writes[0]!.next_attempt_at).toBe(
      new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    );

    const last = deps(() => new Response("down", { status: 503 }));
    await sendDelivery(await due({ attempt: MAX_ATTEMPTS - 1 }), last.d);
    expect(last.writes[0]).toMatchObject({ status: "failed", attempt: MAX_ATTEMPTS });
    expect(last.writes[0]!.next_attempt_at).toBeUndefined();
  });

  it("does not follow a redirect, or send inward, or to a turned-off endpoint", async () => {
    const moved = deps(
      () => new Response(null, { status: 302, headers: { Location: "https://x.test" } }),
    );
    await sendDelivery(await due(), moved.d);
    expect(moved.writes[0]!.last_error).toMatch(/not followed/);

    const inward = deps(() => new Response("ok"));
    await sendDelivery(await due({ url: "https://api.covan.test/hook" }), inward.d);
    expect(inward.fetchImpl).not.toHaveBeenCalled();
    expect(inward.writes[0]).toMatchObject({ status: "pending" });

    const off = deps(() => new Response("ok"));
    await sendDelivery(await due({ disabled_at: "2026-10-21T00:00:00Z" }), off.d);
    expect(off.fetchImpl).not.toHaveBeenCalled();
    expect(off.writes[0]).toMatchObject({ status: "dropped", attempt: 0 });
  });
});

describe("the tick", () => {
  it("claims a bounded batch and sends each", async () => {
    const { d, db, fetchImpl } = deps(() => new Response("ok"));
    db.rpc.mockResolvedValue({ data: [await due(), await due({ id: "d2" })], error: null });

    const out = await dispatchWebhooks({} as never, d);

    expect(db.rpc).toHaveBeenCalledWith("claim_due_webhook_deliveries", { p_limit: 5 });
    expect(out).toEqual({ claimed: 2, delivered: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

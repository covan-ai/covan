import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryDb, type Row } from "../../test-support/memory-db";
import { encryptSecret } from "../secret-box";
import type { ReceivedEmail } from "../inbound-email/resend";
import { REPLIES_PER_HOUR, receiveReply } from "./replies";

vi.mock("../supabase", () => ({
  serviceClient: () => {
    throw new Error("a test must hand in its own db");
  },
}));

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = { ROUTINE_SECRET_KEY: KEY } as never;
const RUN = "3f2a91c0-8c01-4d4e-9a1b-0123456789ab";
const NOW = new Date("2026-10-16T12:00:00Z");

let sealed = "";
beforeAll(async () => {
  sealed = await encryptSecret("deniz@example.com", KEY);
});

const email = (over: Partial<ReceivedEmail> = {}): ReceivedEmail => ({
  id: "e1",
  messageId: "<m1@example.com>",
  from: "Deniz <Deniz@Example.com>",
  to: ["r-x@reply.example.com"],
  subject: "Weekly digest",
  text: "Can you look deeper at the second item?\n\nOn Thu, Covan wrote:\n> 3 new posts",
  headers: { references: "<run-a@reply.example.com>" },
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  createdAt: "2026-10-16T11:59:00Z",
  ...over,
});

function tables(over: { routine?: Row; channel?: Row; runs?: Row[] } = {}) {
  return {
    routine_runs: [
      {
        id: RUN,
        routine_id: "r1",
        summary: "3 new posts",
        triggered_by: null,
        started_at: "2026-10-16T09:00:00Z",
      },
      ...(over.runs ?? []),
    ],
    routines: [
      {
        id: "r1",
        user_id: "u1",
        workspace_id: "w1",
        name: "Weekly digest",
        status: "active",
        deleted_at: null,
        delivery_channel_id: "c1",
        ...over.routine,
      },
    ],
    delivery_channels: [
      {
        id: "c1",
        user_id: "u1",
        kind: "email",
        secret_ciphertext: sealed,
        confirmed_at: "2026-10-01T00:00:00Z",
        disabled_at: null,
        ...over.channel,
      },
    ],
  };
}

function receive(t = tables(), mail = email()) {
  const run = vi.fn(async () => ({ status: "ok", itemsNew: 1 }));
  const deferred: Promise<unknown>[] = [];
  const out = receiveReply(ENV, RUN, mail, {
    db: memoryDb(t).db as unknown as SupabaseClient,
    defer: (p) => deferred.push(p),
    run: run as never,
    now: () => NOW,
  });
  return { out, run, deferred };
}

describe("receiveReply", () => {
  it("runs the routine on the report and the answer, threaded under Re:", async () => {
    const { out, run, deferred } = receive();
    expect(await out).toEqual({ status: "accepted", routineId: "r1" });
    expect(deferred).toHaveLength(1);
    const [, routine, trigger] = run.mock.calls[0] as unknown as [
      unknown,
      Row,
      Record<string, unknown>,
    ];
    expect(routine.id).toBe("r1");
    expect(trigger).toMatchObject({
      eventId: "resend:e1",
      source: "reply",
      label: "Email · Reply",
      thread: {
        inReplyTo: "<m1@example.com>",
        references: "<run-a@reply.example.com> <m1@example.com>",
        subject: "Re: Weekly digest",
      },
    });
    expect(trigger.payload).toContain("3 new posts");
    expect(trigger.payload).toContain("Can you look deeper at the second item?");
    expect(trigger.payload).not.toContain("> 3 new posts");
  });

  it("ignores anybody but the address the routine delivers to", async () => {
    const { out, run } = receive(tables(), email({ from: "someone-else@example.com" }));
    expect(await out).toEqual({ status: "ignored", reason: "not from the routine's address" });
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores a paused routine, an unconfirmed channel, and a report that is not there", async () => {
    expect((await receive(tables({ routine: { status: "paused" } })).out).status).toBe("ignored");
    expect((await receive(tables({ channel: { confirmed_at: null } })).out).status).toBe("ignored");
    expect((await receive(tables({ channel: { kind: "slack_webhook" } })).out).status).toBe(
      "ignored",
    );
    const empty = { ...tables(), routine_runs: [] };
    expect(await receive(empty).out).toEqual({ status: "ignored", reason: "no such report" });
  });

  it("ignores an answer with nothing in it but the quote", async () => {
    const { out } = receive(tables(), email({ text: "> 3 new posts" }));
    expect(await out).toEqual({ status: "ignored", reason: "nothing new in the reply" });
  });

  it("stops after enough replies in an hour", async () => {
    const recent = Array.from({ length: REPLIES_PER_HOUR }, (_, i) => ({
      id: `x${i}`,
      routine_id: "r1",
      summary: "",
      triggered_by: "reply",
      started_at: "2026-10-16T11:30:00Z",
    }));
    const { out, run } = receive(tables({ runs: recent }));
    expect(await out).toEqual({ status: "ignored", reason: "too many replies this hour" });
    expect(run).not.toHaveBeenCalled();
  });
});

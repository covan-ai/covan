import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { ReceivedEmail } from "../inbound-email/resend";
import { readAnswer, receiveApprovalReply } from "./reply";

const env = { ALLOWED_ORIGIN: "https://app.example.com" } as unknown as RoutineEnv;
const REQUEST = "3f2a91c0-8c01-4d4e-9a1b-0123456789ab";

const email = (over: Partial<ReceivedEmail> = {}): ReceivedEmail => ({
  id: "e1",
  messageId: "<m1@acme.test>",
  from: "Ada <ada@acme.test>",
  to: [],
  subject: "Re: Box office agent is waiting for your go-ahead",
  text: "Yes\n\nOn Thu, Box office agent wrote:\n> POST to Box office?",
  headers: {},
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  createdAt: "2026-11-13T07:00:00Z",
  ...over,
});

function world(
  over: {
    request?: Record<string, unknown> | null;
    prefs?: Record<string, unknown> | null;
    owner?: string;
    answer?: string;
  } = {},
) {
  const answered: Array<Record<string, unknown>> = [];
  const table = (rows: Record<string, unknown> | null) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => ({ data: rows, error: null });
    return chain;
  };
  const db = {
    from: (name: string) =>
      name === "paused_turns"
        ? table(over.request === undefined ? { id: REQUEST, user_id: "owner-1" } : over.request)
        : table(over.prefs ?? null),
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: over.owner ?? "ada@acme.test" } } }),
      },
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("answer_approval_as");
      answered.push(args);
      return { data: over.answer ?? "approved", error: null };
    },
  } as unknown as SupabaseClient;
  const mail = vi.fn(async (..._args: unknown[]) => {});
  return { db, mail, answered };
}

describe("readAnswer", () => {
  it("takes one word for yes or no, in either language, quotes cut", () => {
    for (const yes of ["yes", "Yes.", "  OK!", "Evet", "EVET", "onaylıyorum", "Tamam", "approve"]) {
      expect(readAnswer(`${yes}\n\n> the request`), yes).toBe("approve");
    }
    for (const no of ["no", "No.", "HAYIR", "hayir", "Reddet", "decline"]) {
      expect(readAnswer(`${no}\n\nOn Thu, somebody wrote:\n> yes`), no).toBe("decline");
    }
  });

  // Exact, on purpose: no model reads a reply, so anything with a condition
  // in it is not an answer.
  it("takes nothing else as an answer", () => {
    for (const unclear of [
      "yes, but only the small one",
      "maybe",
      "",
      "> yes",
      "not yes",
      "yes no",
    ]) {
      expect(readAnswer(unclear), unclear).toBeNull();
    }
  });
});

describe("receiveApprovalReply", () => {
  it("answers as the owner, through the service role's door, when everything holds", async () => {
    const { db, mail, answered } = world();
    expect(await receiveApprovalReply(env, REQUEST, email(), { db, mail })).toEqual({
      status: "approved",
    });
    expect(answered).toEqual([{ p_id: REQUEST, p_user_id: "owner-1", p_approve: true }]);
    expect(mail).not.toHaveBeenCalled();
  });

  it("ignores somebody who is not the owner, and mails them nothing", async () => {
    const { db, mail, answered } = world();
    const out = await receiveApprovalReply(env, REQUEST, email({ from: "grace@acme.test" }), {
      db,
      mail,
    });
    expect(out).toEqual({ status: "not_owner" });
    expect(answered).toEqual([]);
    expect(mail).not.toHaveBeenCalled();
  });

  it("does not answer for a From its domain's DMARC did not vouch for", async () => {
    const { db, mail, answered } = world();
    const out = await receiveApprovalReply(
      env,
      REQUEST,
      email({ authentication: { spf: "pass", dkim: "pass", dmarc: "gray" } }),
      { db, mail },
    );
    expect(out).toEqual({ status: "unverified" });
    expect(answered).toEqual([]);
    // The owner, at their own address, is sent the link instead.
    const [sent] = mail.mock.calls[0] as [{ to: string; text: string }];
    expect(sent.to).toBe("ada@acme.test");
    expect(sent.text).toContain(`https://app.example.com/approvals/${REQUEST}`);
  });

  it("does not answer for somebody who turned answering by reply off", async () => {
    const { db, mail, answered } = world({ prefs: { approve_by_reply: false } });
    expect(await receiveApprovalReply(env, REQUEST, email(), { db, mail })).toEqual({
      status: "off",
    });
    expect(answered).toEqual([]);
    expect(mail).toHaveBeenCalledOnce();
  });

  it("sends the link back for a reply that is not a plain yes or no", async () => {
    const { db, mail, answered } = world();
    const out = await receiveApprovalReply(env, REQUEST, email({ text: "Yes, but only seat 12" }), {
      db,
      mail,
    });
    expect(out).toEqual({ status: "unclear" });
    expect(answered).toEqual([]);
    expect(mail).toHaveBeenCalledOnce();
  });

  it("says so when somebody answered first", async () => {
    const { db, mail } = world({ answer: "already" });
    expect(await receiveApprovalReply(env, REQUEST, email(), { db, mail })).toEqual({
      status: "already",
    });
    expect(mail).toHaveBeenCalledOnce();
  });

  it("knows nothing of a request that is gone", async () => {
    const { db, mail } = world({ request: null });
    expect(await receiveApprovalReply(env, REQUEST, email(), { db, mail })).toEqual({
      status: "unknown",
    });
    expect(mail).not.toHaveBeenCalled();
  });
});

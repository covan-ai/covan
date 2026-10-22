import { describe, expect, it, vi } from "vitest";
import { sendNeedsYouRemindersWith } from "./needs-you";
import { runWeeklySummariesWith } from "./weekly-summary";
import { needsYouEmail, weeklySummaryEmail } from "../emails/away";

const users: Record<string, string> = {
  u1: "ada@acme.test",
  u2: "bora@acme.test",
  u3: "cem@acme.test",
};
const auth = {
  admin: {
    getUserById: async (id: string) => ({
      data: { user: users[id] ? { id, email: users[id] } : null },
    }),
  },
};

describe("the away-for-an-hour reminder", () => {
  it("sends what was claimed to its person, with a link to the thread", async () => {
    const mail = vi.fn(async (_email: unknown) => {});
    const db = {
      auth,
      rpc: vi.fn(async () => ({
        data: [
          {
            kind: "question",
            ref_id: "m1",
            user_id: "u1",
            workspace_name: "Acme",
            session_id: "s1",
            session_title: "Refunds",
            agent_id: "a1",
            agent_name: "Support",
            summary: "Which order?",
          },
        ],
        error: null,
      })),
    };
    const out = await sendNeedsYouRemindersWith({
      db: db as never,
      mail,
      appUrl: "https://app.covan.test",
    });
    expect(out).toEqual({ sent: 1 });
    const email = mail.mock.calls[0]![0] as ReturnType<typeof needsYouEmail>;
    expect(email.to).toBe("ada@acme.test");
    expect(email.subject).toBe("Support is waiting on you in Acme");
    expect(email.text).toContain("https://app.covan.test/agents/a1/chat?s=s1");
    expect(email.text).toContain("“Which order?”");
  });
});

describe("Monday's summary", () => {
  function setup() {
    const mail = vi.fn(async (_email: unknown) => {});
    const asMember = vi.fn(async (user: { id: string }) => ({
      rpc: async (name: string) => {
        if (name === "home_counts") {
          return { data: [{ threads_window: 5, runs_done: 3, runs_failed: 1 }], error: null };
        }
        if (name === "inbox_counts") return { data: [{ needs_you: 2 }], error: null };
        if (name === "workspace_spend_daily") {
          // Only an admin is answered.
          return user.id === "u1"
            ? {
                data: [
                  {
                    agent_id: "a1",
                    model: "gpt-4o-mini",
                    prompt_tokens: 1_000_000,
                    completion_tokens: 0,
                    cached_tokens: 0,
                    cache_write_tokens: 0,
                  },
                ],
                error: null,
              }
            : { data: null, error: { code: "42501" } };
        }
        if (name === "home_agent_threads")
          return { data: [{ agent_id: "a1", threads: 41 }], error: null };
        return { data: null, error: null };
      },
      from: () => ({
        select: () => ({
          eq: async () => ({ data: [{ id: "a1", name: "Support" }], error: null }),
        }),
      }),
    }));
    const db = {
      auth,
      rpc: async () => ({
        data: [
          { workspace_id: "w1", name: "Acme", week_of: "2026-10-26", weekly_usage_email: true },
        ],
        error: null,
      }),
      from: (table: string) => ({
        select: () =>
          table === "workspace_members"
            ? {
                eq: async () => ({
                  data: [
                    { user_id: "u1", role: "admin" },
                    { user_id: "u2", role: "member" },
                    { user_id: "u3", role: "member" },
                  ],
                  error: null,
                }),
              }
            : {
                in: async () => ({ data: [{ user_id: "u2", weekly_summary: true }], error: null }),
              },
      }),
    };
    return { mail, asMember, db };
  }

  it("gives an admin the usage, a member who asked their own week, and the rest nothing", async () => {
    const { mail, asMember, db } = setup();
    const out = await runWeeklySummariesWith({
      db: db as never,
      asMember: asMember as never,
      mail,
      appUrl: "https://app.covan.test",
      quote: (usd) => usd * 100,
    });
    expect(out).toEqual({ sent: 2 });
    const sent = mail.mock.calls.map((c) => c[0] as ReturnType<typeof weeklySummaryEmail>);
    expect(sent.map((e) => e.to)).toEqual(["ada@acme.test", "bora@acme.test"]);
    expect(sent[0]!.text).toContain("Support: 41 threads");
    expect(sent[0]!.text).not.toContain("Last week you had");
    expect(sent[1]!.text).toContain(
      "Last week you had 5 threads; 2 things are waiting on you now.",
    );
    expect(sent[1]!.text).not.toContain("The workspace used");
    // Every figure was read as its recipient.
    expect(asMember.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["u1", "u2"]);
  });
});

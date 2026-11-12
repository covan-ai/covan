import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { memoryDb, type Row } from "../../test-support/memory-db";
import { approvalRequestEmail, proposalLines } from "../emails/away";
import { notifyApprovalRequest } from "./notify";

const env = { ALLOWED_ORIGIN: "https://app.example.com" } as unknown as RoutineEnv;
const EXPIRES = new Date("2026-11-14T03:00:00.000Z");

const REQUEST = {
  id: "pause-1",
  userId: "owner-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  routineName: "Seat requests",
  summary: "POST to Box office?",
  proposal: { kind: "http_request", connection: { label: "Box office" }, method: "POST" },
  expiresAt: EXPIRES,
};

function world(prefs: Row[] = []) {
  const db = memoryDb({
    notification_preferences: prefs,
    agents: [{ id: "agent-1", name: "Box office agent" }],
    workspaces: [{ id: "ws-1", name: "Acme" }],
    paused_turns: [{ id: "pause-1", reminded_at: null }],
  });
  const client = db.db as unknown as SupabaseClient & { auth: unknown };
  (client as unknown as { auth: unknown }).auth = {
    admin: { getUserById: async () => ({ data: { user: { email: "ada@acme.test" } } }) },
  };
  return { db, client };
}

describe("notifyApprovalRequest", () => {
  it("mails the owner the request's own page, and marks it told", async () => {
    const { db, client } = world();
    const mail = vi.fn(async (..._args: unknown[]) => {});

    expect(await notifyApprovalRequest(env, client, mail, REQUEST)).toBe(true);

    const [sent] = mail.mock.calls[0] as [{ to: string; subject: string; text: string }];
    expect(sent.to).toBe("ada@acme.test");
    expect(sent.subject).toBe("Box office agent is waiting for your go-ahead in Acme");
    expect(sent.text).toContain("https://app.example.com/approvals/pause-1");
    expect(sent.text).toContain("“Seat requests”");
    expect(sent.text).toContain("POST to Box office?");
    expect(sent.text).toContain("2026-11-14 03:00 UTC");
    // The hourly reminder does not say it again.
    expect(db.tables.paused_turns[0].reminded_at).not.toBeNull();
  });

  it("sends nothing to somebody who turned it off", async () => {
    const { db, client } = world([{ user_id: "owner-1", approval_requests: false }]);
    const mail = vi.fn(async (..._args: unknown[]) => {});
    expect(await notifyApprovalRequest(env, client, mail, REQUEST)).toBe(false);
    expect(mail).not.toHaveBeenCalled();
    expect(db.tables.paused_turns[0].reminded_at).toBeNull();
  });

  it("sends nothing on a deployment with no mail, and leaves the reminder to try", async () => {
    const { db, client } = world();
    expect(await notifyApprovalRequest(env, client, null, REQUEST)).toBe(false);
    expect(db.tables.paused_turns[0].reminded_at).toBeNull();
  });

  it("does not throw when the mail provider does", async () => {
    const { client } = world();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const mail = vi.fn(async () => {
      throw new Error("mail refused: 503");
    });
    expect(await notifyApprovalRequest(env, client, mail, REQUEST)).toBe(false);
    quiet.mockRestore();
  });
});

describe("approvalRequestEmail", () => {
  it("escapes what a model or a person wrote", () => {
    const email = approvalRequestEmail({
      email: "ada@acme.test",
      agentName: "<b>Agent</b>",
      workspaceName: "Acme",
      routineName: null,
      summary: "Send <script>",
      proposal: null,
      expiresAt: EXPIRES,
      url: "https://app.example.com/approvals/pause-1",
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<b>Agent</b>");
    expect(email.text).toContain("coming back to a conversation of yours");
  });

  it("shows the arguments as the card's rows, not the catalogue row", () => {
    expect(
      proposalLines({
        kind: "run_tool",
        connection: { id: "c1", label: "Ana's Gmail" },
        slug: "GMAIL_SEND_EMAIL",
        operation: { slug: "GMAIL_SEND_EMAIL", toolkit: "gmail" },
        arguments: { to: "ada@acme.test" },
      }),
    ).toEqual([
      "connection: Ana's Gmail",
      "slug: GMAIL_SEND_EMAIL",
      'arguments: {"to":"ada@acme.test"}',
    ]);
  });
});

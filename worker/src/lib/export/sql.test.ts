import { describe, it, expect } from "vitest";
import { renderSql, MISSING_SECRET, PAUSED_ON_RESTORE } from "./sql";
import type { Collected } from "./collect";

const base = (over: Partial<Collected> = {}): Collected => ({
  workspaces: [{ id: "w1", name: "Acme", slug: "acme", created_by: "u1", created_at: "t0" }],
  workspace_members: [],
  profiles: [],
  agents: [],
  knowledge_bundles: [],
  agent_bundles: [],
  documents: [],
  chat_sessions: [],
  messages: [],
  ideas: [],
  favorites: [],
  delivery_channels: [],
  routines: [],
  routine_runs: [],
  ...over,
});

describe("workspace.sql", () => {
  it("is one transaction, so a restore either happens or does not", () => {
    const { sql } = renderSql(base());
    expect(sql).toContain("\nbegin;\n");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("makes every insert safe to run twice", () => {
    const { sql } = renderSql(base());
    const inserts = sql.split("\n").filter((l) => l.startsWith("insert into"));
    expect(inserts.length).toBeGreaterThan(0);
    for (const line of inserts) expect(line).toMatch(/on conflict do nothing;$/);
  });

  it("preserves ids, so an export and its restore can be compared row for row", () => {
    const { sql } = renderSql(base());
    expect(sql).toContain("'w1'");
  });

  it("leaves profiles out — the account restoring this already has one", () => {
    const { sql } = renderSql(
      base({ profiles: [{ id: "u1", name: "Ayşe", email: "a@example.com" }] }),
    );
    expect(sql).not.toContain("insert into public.profiles");
  });
});

describe("the people", () => {
  it("all become the account running the restore", () => {
    const { sql } = renderSql(
      base({
        agents: [{ id: "a1", workspace_id: "w1", name: "Bot", created_by: "u9", created_at: "t" }],
        chat_sessions: [{ id: "s1", workspace_id: "w1", user_id: "u9", created_at: "t" }],
      }),
    );

    // Never the original id: there is no account behind it in the new install,
    // and a foreign key would refuse it.
    expect(sql).not.toContain("'u9'");
    expect(sql).toContain(":'owner'");
  });

  it("collapse to exactly one membership row, as an admin", () => {
    // Five members all becoming one account would be five inserts of the same
    // primary key: four swallowed by `on conflict do nothing` and the survivor
    // carrying whichever role sorted first. That can hand the restorer a
    // `member` row in their own workspace and lock them out of it.
    const { sql } = renderSql(
      base({
        workspace_members: [
          { workspace_id: "w1", user_id: "u1", role: "member", created_at: "t0" },
          { workspace_id: "w1", user_id: "u2", role: "admin", created_at: "t1" },
          { workspace_id: "w1", user_id: "u3", role: "member", created_at: "t2" },
        ],
      }),
    );

    const rows = sql
      .split("\n")
      .filter((l) => l.startsWith("insert into public.workspace_members"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("'admin'");
    expect(rows[0]).not.toContain("'member'");
  });
});

describe("values", () => {
  it("doubles a quote instead of ending the string", () => {
    const { sql } = renderSql(
      base({ agents: [{ id: "a1", name: "Ayşe's bot", created_at: "t" }] }),
    );
    expect(sql).toContain("'Ayşe''s bot'");
  });

  it("survives an apostrophe used to close the statement", () => {
    // The shape of the injection, written by somebody who named an agent.
    const nasty = "'); drop table public.agents; --";
    const { sql } = renderSql(base({ agents: [{ id: "a1", name: nasty, created_at: "t" }] }));
    expect(sql).toContain("'''); drop table public.agents; --'");
    expect(sql).not.toMatch(/^drop table/m);
  });

  it("writes null, numbers and booleans unquoted", () => {
    const { sql } = renderSql(
      base({ documents: [{ id: "d1", bundle_id: "b1", size: 42, indexed: true, r2_key: null }] }),
    );
    expect(sql).toContain("42");
    expect(sql).toContain("true");
    expect(sql).toContain("NULL");
  });

  it("serialises the jsonb columns rather than stringifying an object", () => {
    const { sql } = renderSql(
      base({
        messages: [{ id: "m1", session_id: "s1", content: "hi", sources: [{ id: "d1" }] }],
      }),
    );
    expect(sql).toContain(`'[{"id":"d1"}]'`);
    expect(sql).not.toContain("[object Object]");
  });
});

describe("references that point outside what the caller could see", () => {
  it("are dropped rather than failing the whole restore", () => {
    // A member's export holds the sessions they may read. An idea cited from a
    // message in somebody else's private session arrives dangling, and one
    // foreign key violation takes the entire transaction with it.
    const { sql, droppedReferences } = renderSql(
      base({
        chat_sessions: [{ id: "s1", workspace_id: "w1", user_id: "u1", created_at: "t" }],
        messages: [{ id: "m1", session_id: "s1", content: "hi", created_at: "t" }],
        ideas: [
          { id: "i1", session_id: "s1", source_message_id: "m1", created_at: "t" },
          { id: "i2", session_id: "s1", source_message_id: "gone", created_at: "t" },
        ],
      }),
    );

    expect(sql).toContain("'m1'");
    expect(sql).not.toContain("'gone'");
    expect(droppedReferences["ideas.source_message_id"]).toBe(1);
  });

  it("are counted, so the loss is stated rather than discovered", () => {
    const { droppedReferences } = renderSql(base());
    expect(droppedReferences).toEqual({});
  });

  it("keep a routine's delivery channel when it is in the archive", () => {
    const { sql, droppedReferences } = renderSql(
      base({
        delivery_channels: [{ id: "c1", workspace_id: "w1", user_id: "u1", kind: "slack" }],
        routines: [
          { id: "r1", workspace_id: "w1", user_id: "u1", delivery_channel_id: "c1", name: "x" },
        ],
      }),
    );
    expect(sql).toContain("'c1'");
    expect(droppedReferences).toEqual({});
  });
});

describe("what the database will not let a restore say honestly", () => {
  const withRoutine = () =>
    renderSql(
      base({
        delivery_channels: [
          { id: "c1", workspace_id: "w1", user_id: "u1", kind: "slack_webhook", label: "#ops" },
        ],
        routines: [
          {
            id: "r1",
            workspace_id: "w1",
            user_id: "u1",
            name: "Morning digest",
            delivery_channel_id: "c1",
            status: "active",
            paused_reason: null,
          },
        ],
      }),
    );

  it("gives a delivery channel a secret that is visibly not one", () => {
    // `secret_ciphertext` is `not null` and the export cannot read it, so the
    // restore has to write something. Before this, every workspace with a
    // delivery channel failed the whole transaction on a not-null violation —
    // which no mocked test could have shown, and the round trip did.
    const { sql } = withRoutine();
    expect(sql).toContain("secret_ciphertext");
    expect(sql).toContain(MISSING_SECRET.replace(/'/g, "''"));
    // Not the shape `lib/routines/crypto` produces, so nothing can mistake it
    // for a credential.
    expect(MISSING_SECRET.startsWith("v1.")).toBe(false);
  });

  it("brings the routine back paused, with the reason on its own row", () => {
    // The placeholder above is only tolerable because of this. A routine whose
    // channel holds no real secret cannot deliver, and one that ran on schedule
    // and failed somewhere nobody is looking would be worse than one that is
    // visibly switched off.
    const { sql } = withRoutine();
    const row = sql.split("\n").find((l) => l.startsWith("insert into public.routines"))!;

    expect(row).toContain("'paused'");
    expect(row).toContain(PAUSED_ON_RESTORE.replace(/'/g, "''"));
    expect(row).not.toContain("'active'");
  });

  it("keeps the rest of the routine exactly as it was", () => {
    const { sql } = withRoutine();
    expect(sql).toContain("'Morning digest'");
    expect(sql).toContain("'c1'");
  });
});

describe("the order of the inserts", () => {
  it("puts a table after everything it points at", () => {
    const { sql } = renderSql(
      base({
        agents: [{ id: "a1", workspace_id: "w1", name: "Bot" }],
        chat_sessions: [{ id: "s1", workspace_id: "w1", agent_id: "a1", user_id: "u1" }],
        messages: [{ id: "m1", session_id: "s1", content: "hi" }],
      }),
    );

    const at = (t: string) => sql.indexOf(`insert into public.${t} `);
    expect(at("workspaces")).toBeLessThan(at("agents"));
    expect(at("agents")).toBeLessThan(at("chat_sessions"));
    expect(at("chat_sessions")).toBeLessThan(at("messages"));
  });
});

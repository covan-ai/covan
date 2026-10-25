import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../registry";
import {
  MAX_OWNER_NOTES,
  MAX_WORKSPACE_NOTES,
  NOTE_CHARS,
  rememberTool,
  scopeFor,
} from "./remember";
import { NOTE_CHARS as TEAM_BLOCK_NOTE_CHARS } from "../../team-block";

/**
 * A client that answers the three questions the tool asks of the database: the
 * caller's role (`mayChangeThings`), how many notes already stand in the scope
 * about to be written to, and the insert itself. Every call is recorded so a
 * test can say what was asked, not only what came back.
 */
function fakeDb(opts: {
  role?: "admin" | "member" | "viewer" | null;
  count?: number;
  insertError?: { code?: string; message: string } | null;
}) {
  const inserts: Array<Record<string, unknown>> = [];
  const counts: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      if (table === "workspace_members") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.role === null ? null : { role: opts.role ?? "member" },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      expect(table).toBe("memory_notes");
      return {
        select: (_cols: string, o: Record<string, unknown>) => {
          expect(o).toEqual({ count: "exact", head: true });
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(col: string, value: unknown) {
              filters[col] = value;
              return chain;
            },
            then(resolve: (v: unknown) => unknown) {
              counts.push(filters);
              return Promise.resolve({ count: opts.count ?? 0, error: null }).then(resolve);
            },
          };
          return chain;
        },
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: opts.insertError ?? null };
        },
      };
    },
  };
  return { db, inserts, counts };
}

function ctxWith(db: unknown, over: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    env: {},
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    sessionId: "session-1",
    ...over,
  } as unknown as ToolContext;
}

const SAVED = " They can see and remove it under Settings › Memory.";

describe("remember", () => {
  it("is a chat tool that asks for nothing and confirms nothing", () => {
    expect(rememberTool.name).toBe("remember");
    expect(rememberTool.destructive).toBe(false);
    expect(rememberTool.isConfigured({} as never)).toBe(true);
    expect(rememberTool.input).toMatchObject({
      type: "object",
      properties: {
        text: { type: "string", maxLength: 280 },
        about: { type: "string", enum: ["person", "team"] },
      },
      required: ["text", "about"],
    });
  });

  it("shares one note-length constant with the block that reads the notes", () => {
    expect(NOTE_CHARS).toBe(280);
    expect(NOTE_CHARS).toBe(TEAM_BLOCK_NOTE_CHARS);
    expect(MAX_OWNER_NOTES).toBe(100);
    expect(MAX_WORKSPACE_NOTES).toBe(200);
  });

  it("keeps a team note private when the thread is private", async () => {
    const { db, inserts } = fakeDb({ role: "member" });
    const res = await rememberTool.run(
      { text: "We ship on Thursdays", about: "team" },
      ctxWith(db, { sessionShared: false }),
    );
    expect(inserts).toEqual([
      {
        workspace_id: "ws-1",
        created_by: "user-1",
        about: "team",
        scope: "owner",
        text: "We ship on Thursdays",
        source: "agent",
        source_session_id: "session-1",
      },
    ]);
    expect(res).toEqual({
      kind: "ok",
      content: `Noted for this person only: "We ship on Thursdays"${SAVED}`,
    });
  });

  it("shares a team note said in a shared thread", async () => {
    const { db, inserts, counts } = fakeDb({ role: "member" });
    const res = await rememberTool.run(
      { text: "We ship on Thursdays", about: "team" },
      ctxWith(db, { sessionShared: true }),
    );
    expect(inserts[0]).toMatchObject({ scope: "workspace", about: "team", created_by: "user-1" });
    // The cap that applies is the workspace's, counted across everybody.
    expect(counts[0]).toEqual({ workspace_id: "ws-1", scope: "workspace" });
    expect(res).toEqual({
      kind: "ok",
      content: `Noted for the team: "We ship on Thursdays"${SAVED}`,
    });
  });

  it("keeps a viewer's team note to themselves even in a shared thread", async () => {
    const { db, inserts } = fakeDb({ role: "viewer" });
    const res = await rememberTool.run(
      { text: "We ship on Thursdays", about: "team" },
      ctxWith(db, { sessionShared: true }),
    );
    expect(inserts[0]).toMatchObject({ scope: "owner" });
    expect(res).toMatchObject({ kind: "ok" });
    expect((res as { content: string }).content).toContain("Noted for this person only");
  });

  it("never shares a note about a person", async () => {
    const { db, inserts } = fakeDb({ role: "admin" });
    await rememberTool.run(
      { text: "Prefers short answers", about: "person" },
      ctxWith(db, { sessionShared: true }),
    );
    expect(inserts[0]).toMatchObject({ scope: "owner", about: "person" });
  });

  it("does not ask the role of a note that cannot be shared", async () => {
    const asked = vi.fn();
    const { db } = fakeDb({});
    const spying = {
      from: (t: string) => {
        asked(t);
        return db.from(t);
      },
    };
    await rememberTool.run(
      { text: "Prefers short answers", about: "person" },
      ctxWith(spying, { sessionShared: true }),
    );
    await rememberTool.run(
      { text: "We ship on Thursdays", about: "team" },
      ctxWith(spying, { sessionShared: false }),
    );
    expect(asked).not.toHaveBeenCalledWith("workspace_members");
  });

  it('says "already noted" on a duplicate', async () => {
    const { db } = fakeDb({ insertError: { code: "23505", message: "duplicate key" } });
    const res = await rememberTool.run(
      { text: "Prefers short answers", about: "person" },
      ctxWith(db),
    );
    expect(res.kind).toBe("ok");
    expect((res as { content: string }).content).toContain("Already noted");
  });

  it("reports any other insert failure as a plain sentence", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ insertError: { code: "42501", message: "rls" } });
    const res = await rememberTool.run(
      { text: "Prefers short answers", about: "person" },
      ctxWith(db),
    );
    expect(res.kind).toBe("error");
    expect((res as { message: string }).message).not.toContain("rls");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("refuses past the cap with a sentence the model can relay", async () => {
    const { db, inserts, counts } = fakeDb({ count: MAX_OWNER_NOTES });
    const res = await rememberTool.run(
      { text: "Prefers short answers", about: "person" },
      ctxWith(db),
    );
    expect(inserts).toEqual([]);
    expect(counts[0]).toEqual({ workspace_id: "ws-1", created_by: "user-1", scope: "owner" });
    expect(res.kind).toBe("error");
    expect((res as { message: string }).message).toContain("Settings › Memory");
  });

  it("refuses past the workspace cap for a shared note", async () => {
    const { db, inserts } = fakeDb({ role: "member", count: MAX_WORKSPACE_NOTES });
    const res = await rememberTool.run(
      { text: "We ship on Thursdays", about: "team" },
      ctxWith(db, { sessionShared: true }),
    );
    expect(inserts).toEqual([]);
    expect(res.kind).toBe("error");
    expect((res as { message: string }).message).toContain("Settings › Memory");
  });

  it("still writes one under the cap", async () => {
    const { db, inserts } = fakeDb({ count: MAX_OWNER_NOTES - 1 });
    const res = await rememberTool.run(
      { text: "Prefers short answers", about: "person" },
      ctxWith(db),
    );
    expect(res.kind).toBe("ok");
    expect(inserts).toHaveLength(1);
  });

  it("refuses outside a conversation", async () => {
    const { db, inserts } = fakeDb({});
    const res = await rememberTool.run(
      { text: "Prefers short answers", about: "person" },
      ctxWith(db, { sessionId: undefined }),
    );
    expect(res.kind).toBe("error");
    expect((res as { message: string }).message).toContain("conversation");
    expect(inserts).toEqual([]);
  });

  it("trims the text, and refuses an empty one", async () => {
    const { db, inserts } = fakeDb({});
    const ok = await rememberTool.run(
      { text: "  Prefers short answers \n", about: "person" },
      ctxWith(db),
    );
    expect(inserts[0]).toMatchObject({ text: "Prefers short answers" });
    expect((ok as { content: string }).content).toContain('"Prefers short answers"');

    for (const text of ["", "   \n\t"]) {
      const res = await rememberTool.run({ text, about: "person" }, ctxWith(db));
      expect(res.kind).toBe("error");
    }
    expect(inserts).toHaveLength(1);
  });

  it("refuses a note over the limit rather than storing half a sentence", async () => {
    const { db, inserts } = fakeDb({});
    const ok = await rememberTool.run(
      { text: "a".repeat(NOTE_CHARS), about: "person" },
      ctxWith(db),
    );
    expect(ok.kind).toBe("ok");
    const res = await rememberTool.run(
      { text: "a".repeat(NOTE_CHARS + 1), about: "person" },
      ctxWith(db),
    );
    expect(res.kind).toBe("error");
    expect((res as { message: string }).message).toContain("280");
    expect(inserts).toHaveLength(1);
  });

  it("refuses an about it does not know, and a text that is not a string", async () => {
    const { db, inserts } = fakeDb({});
    expect((await rememberTool.run({ text: "x", about: "everyone" }, ctxWith(db))).kind).toBe(
      "error",
    );
    expect((await rememberTool.run({ text: 5, about: "person" }, ctxWith(db))).kind).toBe("error");
    expect(inserts).toEqual([]);
  });
});

describe("scopeFor", () => {
  const ctx = (sessionShared?: boolean) =>
    ({ sessionShared }) as Pick<ToolContext, "sessionShared" | "db" | "workspaceId" | "userId">;
  it("shares only a team note, in a shared thread, by someone who may write", () => {
    expect(scopeFor("team", ctx(true), true)).toBe("workspace");
    expect(scopeFor("team", ctx(true), false)).toBe("owner");
    expect(scopeFor("team", ctx(false), true)).toBe("owner");
    expect(scopeFor("team", ctx(undefined), true)).toBe("owner");
    expect(scopeFor("person", ctx(true), true)).toBe("owner");
  });
});

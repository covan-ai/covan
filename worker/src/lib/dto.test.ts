import { describe, it, expect } from "vitest";
import { mapDocument, mapMessage, mapAgent, mapChatSession, mapIdea, mapRoutine } from "./dto";

describe("mapDocument", () => {
  it("marks a document indexed when it has embedded chunks", () => {
    const d = mapDocument({ id: "d1", name: "a.md", size: 20, document_chunks: [{ count: 3 }] });
    expect(d).toMatchObject({ id: "d1", name: "a.md", size: 20, chunkCount: 3, indexed: true });
  });

  it("marks a document not indexed when it has zero chunks", () => {
    expect(
      mapDocument({ id: "d2", name: "b.md", size: 5, document_chunks: [{ count: 0 }] }),
    ).toMatchObject({ chunkCount: 0, indexed: false });
    expect(mapDocument({ id: "d3", name: "c.md", size: 5, document_chunks: [] })).toMatchObject({
      chunkCount: 0,
      indexed: false,
    });
    expect(mapDocument({ id: "d4", name: "d.md", size: 5 })).toMatchObject({
      chunkCount: 0,
      indexed: false,
    });
  });

  it("defaults a null size to 0", () => {
    expect(mapDocument({ id: "d5", name: "e.md", size: null }).size).toBe(0);
  });
});

describe("mapMessage", () => {
  const base = { id: "m1", role: "assistant", content: "hi", created_at: "2026-01-01T00:00:00Z" };

  it("surfaces a string[] sources array", () => {
    expect(mapMessage({ ...base, sources: ["a.md", "b.md"] }).sources).toEqual(["a.md", "b.md"]);
  });

  it("drops non-string entries and yields undefined when absent", () => {
    expect(mapMessage({ ...base, sources: ["a.md", 3, null] }).sources).toEqual(["a.md"]);
    expect(mapMessage({ ...base }).sources).toBeUndefined();
    expect(mapMessage({ ...base, sources: "nope" }).sources).toBeUndefined();
  });
});

describe("mapAgent", () => {
  it("flattens documents across bundles and carries indexing status", () => {
    const agent = mapAgent({
      id: "a1",
      name: "Agent",
      emoji: null,
      model: null,
      persona: null,
      created_at: "2026-01-01T00:00:00Z",
      agent_bundles: [
        {
          bundle_id: "b1",
          knowledge_bundles: {
            documents: [{ id: "d1", name: "x.md", size: 10, document_chunks: [{ count: 2 }] }],
          },
        },
        {
          bundle_id: "b2",
          knowledge_bundles: {
            documents: [{ id: "d2", name: "y.md", size: null, document_chunks: [] }],
          },
        },
      ],
    });
    expect(agent.bundleIds).toEqual(["b1", "b2"]);
    expect(agent.documents).toEqual([
      { id: "d1", name: "x.md", size: 10, chunkCount: 2, indexed: true },
      { id: "d2", name: "y.md", size: 0, chunkCount: 0, indexed: false },
    ]);
  });

  it("handles an agent with no bundles", () => {
    const agent = mapAgent({
      id: "a2",
      name: "Solo",
      emoji: "🤖",
      model: "gpt",
      persona: "p",
      created_at: "2026-01-01T00:00:00Z",
      agent_bundles: [],
    });
    expect(agent.documents).toEqual([]);
    expect(agent.bundleIds).toEqual([]);
  });

  it("maps mode, defaulting null/unknown to normal", () => {
    const base = {
      id: "a1",
      name: "A",
      emoji: null,
      model: null,
      persona: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(mapAgent({ ...base, mode: "brainstorm" }).mode).toBe("brainstorm");
    expect(mapAgent({ ...base, mode: "normal" }).mode).toBe("normal");
    expect(mapAgent({ ...base, mode: null }).mode).toBe("normal");
    expect(mapAgent({ ...base }).mode).toBe("normal");
  });
});

describe("mapMessage sender", () => {
  const base = { id: "m1", role: "user", content: "hi", created_at: "2026-01-01T00:00:00Z" };

  it("maps an embedded sender profile to camelCase", () => {
    const m = mapMessage({
      ...base,
      sender_id: "u1",
      sender: { id: "u1", name: "Ada", avatar_url: "http://x/a.png" },
    });
    expect(m.sender).toEqual({ id: "u1", name: "Ada", avatarUrl: "http://x/a.png" });
  });

  it("yields undefined sender for assistant / missing sender", () => {
    expect(mapMessage({ ...base, role: "assistant" }).sender).toBeUndefined();
    expect(mapMessage({ ...base }).sender).toBeUndefined();
    // PostgREST can return an empty array when no related row matched.
    expect(mapMessage({ ...base, sender: [] as unknown }).sender).toBeUndefined();
  });
});

describe("mapChatSession visibility/owner", () => {
  const row = {
    id: "s1",
    agent_id: "a1",
    user_id: "u1",
    title: "T",
    visibility: "shared",
    updated_at: "2026-01-01T00:00:00Z",
    messages: [{ count: 2 }],
  };

  it("surfaces visibility and ownerId", () => {
    const s = mapChatSession(row, []);
    expect(s).toMatchObject({ id: "s1", visibility: "shared", ownerId: "u1", messageCount: 2 });
  });

  it("defaults unknown/absent visibility to private", () => {
    expect(mapChatSession({ ...row, visibility: undefined }, []).visibility).toBe("private");
    expect(mapChatSession({ ...row, visibility: "bogus" }, []).visibility).toBe("private");
  });
});

describe("mapIdea", () => {
  const base = {
    id: "i1",
    session_id: "s1",
    title: "Ship a free tier",
    detail: "Cap usage at 50 msgs/mo",
    stage: "promising",
    position: 2,
    created_by: "u1",
    source_message_id: "m9",
    created_at: "2026-01-01T00:00:00Z",
  };

  it("maps all fields to the camelCase DTO with epoch-ms createdAt", () => {
    expect(mapIdea(base)).toEqual({
      id: "i1",
      sessionId: "s1",
      title: "Ship a free tier",
      detail: "Cap usage at 50 msgs/mo",
      stage: "promising",
      position: 2,
      createdBy: "u1",
      sourceMessageId: "m9",
      createdAt: new Date("2026-01-01T00:00:00Z").getTime(),
    });
  });

  it("falls back an unknown stage to 'review' and preserves nulls", () => {
    const m = mapIdea({
      ...base,
      stage: "bogus",
      detail: null,
      created_by: null,
      source_message_id: null,
    });
    expect(m.stage).toBe("review");
    expect(m.detail).toBeNull();
    expect(m.createdBy).toBeNull();
    expect(m.sourceMessageId).toBeNull();
  });
});

describe("mapChatSession kind", () => {
  const row = {
    id: "s1",
    agent_id: "a1",
    user_id: "u1",
    title: null,
    updated_at: "2026-01-01T00:00:00Z",
  };
  it("defaults kind to 'chat' when absent", () => {
    expect(mapChatSession(row).kind).toBe("chat");
  });
  it("carries brainstorm kind", () => {
    expect(mapChatSession({ ...row, kind: "brainstorm" }).kind).toBe("brainstorm");
  });
});

describe("mapRoutine", () => {
  const row = {
    id: "r1",
    agent_id: "a1",
    user_id: "u1",
    name: "r/SaaS new posts",
    visibility: "shared",
    source_kind: "rss",
    source_config: { url: "https://example.com/feed.xml" },
    instruction: "summarise",
    delivery_channel_id: "c1",
    schedule_cron: "0 * * * *",
    timezone: "Europe/Istanbul",
    status: "active",
    paused_reason: null,
    next_run_at: "2026-08-16T12:00:00Z",
    last_run_at: null,
    created_at: "2026-08-16T10:00:00Z",
  };

  // The client groups Team vs My routines and decides whether to render edit
  // controls entirely from this field.
  it("carries the owner through", () => {
    expect(mapRoutine(row).userId).toBe("u1");
  });
});

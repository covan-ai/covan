import { describe, it, expect, vi, beforeEach } from "vitest";

type PostedMessage = { channel: string; threadTs: string; text: string };

const { postMessage, lookupEmail } = vi.hoisted(() => ({
  postMessage: vi.fn(
    async (
      _fetch: unknown,
      _token: string,
      _message: { channel: string; threadTs: string; text: string },
    ) => {},
  ),
  lookupEmail: vi.fn(async () => "deniz@covan.app" as string | null),
}));

/** What the app said, on the nth reply it posted. */
const posted = (index = 0): PostedMessage => postMessage.mock.calls[index][2];
vi.mock("./api", () => ({ postMessage, lookupEmail, SlackError: Error }));

const { retrieveForAgent } = vi.hoisted(() => ({
  retrieveForAgent: vi.fn(async () => ({
    docNames: ["Handbook.md"],
    bundleIds: ["bundle-1"],
    ragBlock: "Document: Handbook.md\nTwenty days.",
    sources: [{ id: "doc-1", name: "Handbook.md" }],
    embeddingTokens: 40,
  })),
}));
vi.mock("../retrieval", () => ({ retrieveForAgent }));

const { create } = vi.hoisted(() => ({
  create: vi.fn(async () => ({
    choices: [{ message: { content: "Twenty days a year." } }],
    usage: { prompt_tokens: 500, completion_tokens: 20 },
  })),
}));
vi.mock("../openai", () => ({
  createOpenAI: () => ({ chat: { completions: { create } } }),
}));

import { fakeDb, type QueryContext } from "../../test-support/fake-db";
import { handleSlackEvent, shouldAnswer, stripMention, type InstallationRow } from "./handle";
import { encryptSecret } from "../secret-box";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const BOT = "U-BOT";

const env = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  SUPABASE_ANON_KEY: "anon",
  OPENAI_API_KEY: "sk-test",
  ROUTINE_SECRET_KEY: KEY,
  RESEND_API_KEY: "",
  RESEND_FROM: "",
  ALLOWED_ORIGIN: "https://app.example.com",
} as never;

const unlimited = {
  check: vi.fn(async () => ({ allowed: true }) as const),
  record: vi.fn(async () => {}),
  snapshot: vi.fn(async () => ({ used: 0, limit: null, resetsAt: null })),
};

async function installation(overrides: Partial<InstallationRow> = {}): Promise<InstallationRow> {
  return {
    id: "install-1",
    workspace_id: "ws-1",
    team_id: "T-1",
    bot_user_id: BOT,
    secret_ciphertext: await encryptSecret("xoxb-token", KEY),
    agent_id: "agent-1",
    ...overrides,
  };
}

const mention = (overrides: Record<string, unknown> = {}) => ({
  type: "app_mention" as const,
  user: "U-DENIZ",
  text: `<@${BOT}> kaç gün izin hakkım var?`,
  channel: "C-1",
  ts: "1725273600.000100",
  ...overrides,
});

/** A database where the asker is known, the agent exists and the thread is new. */
function db(
  options: {
    identity?: boolean;
    profile?: boolean;
    member?: boolean;
    agent?: boolean;
    existingSession?: string;
  } = {},
) {
  return fakeDb({
    tables: {
      slack_identities: {
        select: () => ({ data: options.identity ? { user_id: "user-1" } : null, error: null }),
        insert: () => ({ data: null, error: null }),
      },
      profiles: {
        select: () => ({ data: options.profile === false ? null : { id: "user-1" }, error: null }),
      },
      workspace_members: {
        select: () => ({
          data: options.member === false ? null : { user_id: "user-1" },
          error: null,
        }),
      },
      agents: {
        select: () => ({
          data:
            options.agent === false
              ? null
              : { id: "agent-1", name: "Covan", persona: null, model: null, mode: "normal" },
          error: null,
        }),
      },
      slack_threads: {
        select: () => ({
          data: options.existingSession ? { session_id: options.existingSession } : null,
          error: null,
        }),
        insert: () => ({ data: null, error: null }),
      },
      chat_sessions: {
        insert: () => ({ data: { id: "session-1" }, error: null }),
        delete: () => ({ data: null, error: null }),
      },
      messages: {
        insert: () => ({ data: null, error: null }),
        select: () => ({ data: [], error: null }),
      },
    },
  });
}

const deps = (fake: ReturnType<typeof fakeDb>, entitlements: unknown = unlimited) => ({
  db: fake.db as never,
  env,
  entitlements: entitlements as never,
  fetchImpl: (async () => new Response("")) as unknown as typeof fetch,
});

beforeEach(() => {
  vi.clearAllMocks();
  lookupEmail.mockResolvedValue("deniz@covan.app");
  create.mockResolvedValue({
    choices: [{ message: { content: "Twenty days a year." } }],
    usage: { prompt_tokens: 500, completion_tokens: 20 },
  });
});

describe("which events are answered", () => {
  it("answers a mention and a direct message", () => {
    expect(shouldAnswer(mention(), BOT)).toBe(true);
    expect(
      shouldAnswer({ ...mention(), type: "message", channel_type: "im", text: "merhaba" }, BOT),
    ).toBe(true);
  });

  // Three ways the app hears itself. Answering any of them is a loop that runs
  // at the workspace's expense until somebody notices.
  it("never answers itself", () => {
    expect(shouldAnswer({ ...mention(), bot_id: "B-1" }, BOT)).toBe(false);
    expect(shouldAnswer({ ...mention(), user: BOT }, BOT)).toBe(false);
    expect(shouldAnswer({ ...mention(), subtype: "message_changed" }, BOT)).toBe(false);
  });

  it("ignores an ordinary channel message that did not ask it anything", () => {
    expect(shouldAnswer({ ...mention(), type: "message", channel_type: "channel" }, BOT)).toBe(
      false,
    );
  });

  it("ignores an empty message", () => {
    expect(shouldAnswer({ ...mention(), text: "   " }, BOT)).toBe(false);
  });

  it("takes its own id out of the question", () => {
    expect(stripMention(`<@${BOT}> what is the leave policy?`, BOT)).toBe(
      "what is the leave policy?",
    );
  });
});

describe("answering in a thread", () => {
  it("answers the asker's question in the thread it was asked in", async () => {
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(posted()).toMatchObject({ channel: "C-1", threadTs: "1725273600.000100" });
    expect(posted().text).toContain("Twenty days a year.");
    // Slack has no chips, so the documents an answer stood on become a line.
    expect(posted().text).toContain("Handbook.md");
  });

  it("keeps the exchange in Covan as an ordinary conversation", async () => {
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    const session = fake.callsTo("chat_sessions").find((c) => c.op === "insert");
    expect(session?.values).toMatchObject({
      agent_id: "agent-1",
      user_id: "user-1",
      workspace_id: "ws-1",
      // Asked in front of a channel, so it is not a private room.
      visibility: "shared",
    });

    const written = fake.callsTo("messages").filter((c) => c.op === "insert");
    expect(written[0]?.values).toMatchObject({ role: "user", sender_id: "user-1" });
    expect(written[1]?.values).toMatchObject({ role: "assistant", prompt_tokens: 500 });
  });

  it("treats a direct message as a private conversation", async () => {
    const fake = db({ identity: true });

    await handleSlackEvent(
      await installation(),
      { ...mention(), type: "message", channel_type: "im", text: "merhaba" },
      deps(fake),
    );

    expect(fake.callsTo("chat_sessions").find((c) => c.op === "insert")?.values).toMatchObject({
      visibility: "private",
    });
  });

  it("continues an existing thread rather than starting a second conversation", async () => {
    const fake = db({ identity: true, existingSession: "session-old" });

    await handleSlackEvent(
      await installation(),
      { ...mention(), thread_ts: "1725273600.000100", ts: "1725273999.000200" },
      deps(fake),
    );

    expect(fake.callsTo("chat_sessions").some((c) => c.op === "insert")).toBe(false);
    expect(fake.callsTo("messages").find((c) => c.op === "insert")?.values).toMatchObject({
      session_id: "session-old",
    });
  });

  it("learns who somebody is once, by email, and remembers it", async () => {
    const fake = db({ identity: false });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(lookupEmail).toHaveBeenCalledWith(expect.anything(), "xoxb-token", "U-DENIZ");
    expect(fake.callsTo("slack_identities").find((c) => c.op === "insert")?.values).toMatchObject({
      installation_id: "install-1",
      slack_user_id: "U-DENIZ",
      user_id: "user-1",
    });
  });

  // The whole reason `slack_identities` exists. Answering as the installer
  // instead would retrieve with their access and log the question as theirs.
  it("refuses to answer somebody it cannot identify", async () => {
    lookupEmail.mockResolvedValue(null);
    const fake = db({ identity: false });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(create).not.toHaveBeenCalled();
    expect(posted().text).toMatch(/don't know who you are/i);
  });

  it("refuses somebody whose email is in Covan but not in this workspace", async () => {
    const fake = db({ identity: false, member: false });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(create).not.toHaveBeenCalled();
    expect(fake.callsTo("slack_identities").some((c) => c.op === "insert")).toBe(false);
  });

  it("spends nothing once the asker's allowance is used up", async () => {
    const fake = db({ identity: true });
    const spent = {
      ...unlimited,
      check: vi.fn(async () => ({
        allowed: false as const,
        used: 300000,
        limit: 300000,
        resetsAt: "2026-10-01T00:00:00Z",
      })),
    };

    await handleSlackEvent(await installation(), mention(), deps(fake, spent));

    expect(create).not.toHaveBeenCalled();
    expect(posted().text).toMatch(/allowance/i);
  });

  it("says which choice is missing when no agent is set", async () => {
    const fake = db({ identity: true });

    await handleSlackEvent(await installation({ agent_id: null }), mention(), deps(fake));

    expect(create).not.toHaveBeenCalled();
    expect(posted().text).toMatch(/no agent is set/i);
  });

  it("charges the asker for the turn, embedding included", async () => {
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    // 500 prompt + 20 completion + ceil(40 * 0.01) embedding tokens.
    expect(unlimited.record).toHaveBeenCalledWith("user-1", 521);
  });

  it("still charges for the embedding when the model call fails", async () => {
    create.mockRejectedValue(new Error("upstream down"));
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(unlimited.record).toHaveBeenCalledWith("user-1", 1);
    expect(posted().text).toMatch(/went wrong/i);
  });
});

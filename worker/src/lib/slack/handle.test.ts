import { describe, it, expect, vi, beforeEach } from "vitest";
import { getRateLimiter, resetRateLimiters, userRateKey } from "../ratelimit";

type PostedMessage = { channel: string; threadTs: string; text: string };

const { postMessage, lookupEmail, isPublicChannel } = vi.hoisted(() => ({
  postMessage: vi.fn(
    async (
      _fetch: unknown,
      _token: string,
      _message: { channel: string; threadTs: string; text: string },
    ) => {},
  ),
  lookupEmail: vi.fn(async () => "deniz@covan.app" as string | null),
  isPublicChannel: vi.fn(async (_fetch: unknown, _token: string, _channel: string) => true),
}));

/** What the app said, on the nth reply it posted. */
const posted = (index = 0): PostedMessage => postMessage.mock.calls[index][2];
vi.mock("./api", () => ({ postMessage, lookupEmail, isPublicChannel, SlackError: Error }));

const { retrieveForAgent } = vi.hoisted(() => ({
  // Arguments declared rather than dropped: the second one is the env the
  // embedding is bought with, which is half of whose key answered a turn.
  retrieveForAgent: vi.fn(async (_db: unknown, _env: unknown, ..._rest: unknown[]) => ({
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
    // `finish_reason` on every fixture below, because the handler reads it now
    // and a choice on the wire always carries one. A reply that omitted it
    // would be a reply no provider sends.
    choices: [{ message: { content: "Twenty days a year." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 500, completion_tokens: 20 },
  })),
}));
// A spy rather than a bare arrow: which env this is handed is the whole of
// whose key answered, and a mock that drops its argument cannot tell the two
// apart.
const { createOpenAI } = vi.hoisted(() => ({
  createOpenAI: vi.fn((_env: unknown) => ({ chat: { completions: { create } } })),
}));
vi.mock("../openai", () => ({ createOpenAI }));

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
  snapshot: vi.fn(async () => ({ metered: false as const })),
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
    /**
     * The asker's active workspace, for the two reads `getActiveWorkspaceId`
     * makes on the way to a workspace's own provider key. `null` — the default
     * — is somebody with no active workspace, which is where that lookup gives
     * up and the operator's keys answer.
     */
    activeWorkspace?: string | null;
    /** What `agent_access_for` says the asker may do (0103); null is nothing. */
    access?: string | null;
  } = {},
) {
  const activeWorkspace = options.activeWorkspace ?? null;
  return fakeDb({
    rpc: {
      agent_access_for: () => ({
        data: options.access === undefined ? "use" : options.access,
        error: null,
      }),
    },
    tables: {
      slack_identities: {
        select: () => ({ data: options.identity ? { user_id: "user-1" } : null, error: null }),
        insert: () => ({ data: null, error: null }),
      },
      profiles: {
        select: () => ({
          data:
            options.profile === false
              ? null
              : { id: "user-1", active_workspace_id: activeWorkspace },
          error: null,
        }),
      },
      workspace_members: {
        select: () => ({
          data:
            options.member === false ? null : { user_id: "user-1", workspace_id: activeWorkspace },
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
  // One person asks every question in this file, and the per-person rate is
  // real: without this the twenty-first test would be refused.
  resetRateLimiters();
  lookupEmail.mockResolvedValue("deniz@covan.app");
  isPublicChannel.mockResolvedValue(true);
  // clearAllMocks wipes call history but leaves an implementation an earlier
  // test installed in place, so both of these are re-asserted rather than
  // assumed.
  createOpenAI.mockImplementation(() => ({ chat: { completions: { create } } }));
  create.mockResolvedValue({
    choices: [{ message: { content: "Twenty days a year." }, finish_reason: "stop" }],
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

  // The model writes Markdown because every other surface in Covan renders it.
  // Slack's `text` is mrkdwn, so an answer posted straight through arrives with
  // its asterisks and brackets showing. `lib/slack/mrkdwn` covers the language
  // itself; this is the wiring.
  it("posts the answer in the language Slack reads", async () => {
    create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "**Twenty days** a year — see [the policy](https://example.com/p).",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 20 },
    });
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(posted().text).toContain(
      "*Twenty days* a year — see <https://example.com/p|the policy>.",
    );
    expect(posted().text).not.toContain("**");
  });

  it("keeps the exchange in Covan as an ordinary conversation", async () => {
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    const session = fake.callsTo("chat_sessions").find((c) => c.op === "insert");
    expect(session?.values).toMatchObject({
      agent_id: "agent-1",
      user_id: "user-1",
      workspace_id: "ws-1",
      // Asked in a public channel, so it is not a private room.
      visibility: "shared",
    });

    const written = fake.callsTo("messages").filter((c) => c.op === "insert");
    expect(written[0]?.values).toMatchObject({ role: "user", sender_id: "user-1" });
    expect(written[1]?.values).toMatchObject({
      role: "assistant",
      prompt_tokens: 500,
      // Which model answered and how it ended, the same two facts the chat
      // routes record. A Slack answer is one completion with no tool loop, so
      // it either answered or never reached this line.
      model: "gpt-4.1",
      outcome: "answered",
    });
  });

  // The one place the missing finish reason was a live bug rather than a gap.
  // Slack has no Continue button, so a cut-off answer is not a truncated answer
  // here — it is a wrong one, and `outcome: "answered"` said it was right.
  it("records a cut-off answer as truncated, not answered", async () => {
    create.mockResolvedValueOnce({
      choices: [{ message: { content: "Twenty days a" }, finish_reason: "length" }],
      usage: { prompt_tokens: 500, completion_tokens: 20 },
    });
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    const written = fake.callsTo("messages").filter((c) => c.op === "insert");
    expect(written[1]?.values).toMatchObject({ role: "assistant", outcome: "truncated" });
    // Still posted: half an answer the person can see beats a silent drop, and
    // the row is what records that it was half.
    expect(posted().text).toContain("Twenty days a");
  });

  it("sends what it retrieved as data, not as its own instructions", async () => {
    // Finding 8 of the 2026-10-08 audit. This path assembles the same way the
    // chat route does, and it had the same defect: the retrieved block rode as
    // a `system` message. On Slack the material is likelier still to have been
    // written by somebody outside the workspace — a synced channel is a feed.
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    // `create` is declared with no parameters, so the recorded call has to be
    // told what it was.
    const [request] = create.mock.calls[0] as unknown as [
      { messages: { role: string; content: string }[] },
    ];
    const messages = request.messages;
    const at = messages.findIndex((m) => m.content.includes("Twenty days."));
    expect(messages[at]?.role).toBe("user");
    // And it is still its own message behind the persona, which is what the
    // prompt cache reads back. (This fixture's fake `messages` table returns no
    // rows, so the re-read history is empty and there is no question turn after
    // it — the role is the whole of what this test is about.)
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).not.toContain("Twenty days.");
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

  // A private channel or a group DM is a room most of the workspace is not
  // in. Shared, its conversation would show every member of the Covan
  // workspace what was said there.
  it("treats a mention in a channel Slack does not call public as private", async () => {
    isPublicChannel.mockResolvedValue(false);
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(isPublicChannel).toHaveBeenCalledWith(expect.anything(), expect.any(String), "C-1");
    expect(fake.callsTo("chat_sessions").find((c) => c.op === "insert")?.values).toMatchObject({
      visibility: "private",
    });
  });

  it("does not ask Slack about the channel for a thread it already has", async () => {
    const fake = db({ identity: true, existingSession: "session-old" });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(isPublicChannel).not.toHaveBeenCalled();
  });

  it("names the sources as text, so a document name cannot ping anybody", async () => {
    retrieveForAgent.mockResolvedValueOnce({
      docNames: ["<!channel> notes"],
      bundleIds: ["bundle-1"],
      ragBlock: "Document: <!channel> notes\nTwenty days.",
      sources: [{ id: "doc-1", name: "<!channel> notes" }],
      embeddingTokens: 40,
    });
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    const text = posted(postMessage.mock.calls.length - 1).text;
    expect(text).toContain("_From: &lt;!channel> notes_");
    expect(text).not.toContain("<!channel>");
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

  it("matches an address exactly, so a * in it is not a wildcard", async () => {
    // PostgREST reads `*` in an ilike pattern as `%`. A Slack account named
    // `*@covan.app` matched whichever one member had an address there.
    lookupEmail.mockResolvedValueOnce("*@covan.app");
    const fake = db({ identity: false });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    const lookup = fake.callsTo("profiles").find((c) => c.op === "select");
    expect(lookup?.filters).toContainEqual({ column: "email", value: "*@covan.app", kind: "eq" });
    expect(lookup?.filters.some((f) => f.kind === "ilike")).toBe(false);
  });

  it("refuses somebody whose email is in Covan but not in this workspace", async () => {
    const fake = db({ identity: false, member: false });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(create).not.toHaveBeenCalled();
    expect(fake.callsTo("slack_identities").some((c) => c.op === "insert")).toBe(false);
  });

  // The other half of the same question, and the one the cache used to skip.
  // `slack_identities` remembers who somebody is; it cannot remember whether
  // they may still ask, because membership is revocable and the mapping is not.
  it("refuses a remembered asker who has since left the workspace", async () => {
    const fake = db({ identity: true, member: false });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(create).not.toHaveBeenCalled();
    expect(posted().text).toMatch(/don't know who you are/i);
    // And the mapping stays: see the comment in `resolveIdentity` for why
    // forgetting them is the worse of the two answers.
    expect(fake.callsTo("slack_identities").some((c) => c.op === "delete")).toBe(false);
  });

  // 0103: a member is not enough. The agent has to be shared with them, and
  // the handler holds the service role, so nothing but this check says so.
  it("refuses a member the agent is not shared with, and opens no conversation", async () => {
    const fake = db({ identity: true, access: null });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(create).not.toHaveBeenCalled();
    expect(posted().text).toMatch(/isn't shared with you/i);
    expect(fake.callsTo("chat_sessions").some((c) => c.op === "insert")).toBe(false);
    expect(fake.callsTo("messages").some((c) => c.op === "insert")).toBe(false);
  });

  it("spends nothing once the workspace's credits are gone", async () => {
    const fake = db({ identity: true });
    const spent = {
      ...unlimited,
      check: vi.fn(async () => ({ allowed: false as const, balance: 0 })),
    };

    await handleSlackEvent(await installation(), mention(), deps(fake, spent));

    expect(spent.check).toHaveBeenCalledWith("ws-1");
    expect(create).not.toHaveBeenCalled();
    expect(posted().text).toMatch(/no Covan credits left/i);
  });

  it("spends nothing for somebody asking faster than the chat screen would let them", async () => {
    // Slack buys the same completion a chat turn does, so it spends the same
    // per-person allowance — the bucket `rateLimit("expensive")` counts in.
    const fake = db({ identity: true });
    await handleSlackEvent(await installation(), mention(), deps(fake));
    create.mockClear();
    const asker = fake.callsTo("messages").find((c) => c.op === "insert")?.values?.sender_id;
    expect(typeof asker).toBe("string");
    for (let i = 0; i < 20; i++) {
      await getRateLimiter(env, "expensive").check(userRateKey("expensive", asker as string));
    }

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(create).not.toHaveBeenCalled();
    expect(posted(postMessage.mock.calls.length - 1).text).toMatch(/faster than I can answer/i);
  });

  it("says which choice is missing when no agent is set", async () => {
    const fake = db({ identity: true });

    await handleSlackEvent(await installation({ agent_id: null }), mention(), deps(fake));

    expect(create).not.toHaveBeenCalled();
    expect(posted().text).toMatch(/no agent is set/i);
  });

  it("charges the installation's workspace for the turn, embedding included", async () => {
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(unlimited.record).toHaveBeenCalledWith(
      "ws-1",
      [
        { kind: "embedding", model: "text-embedding-3-small", tokens: 40, purpose: "retrieval" },
        expect.objectContaining({
          kind: "completion",
          promptTokens: 500,
          completionTokens: 20,
          purpose: "slack",
        }),
      ],
      { userId: "user-1" },
    );
  });

  it("still charges for the embedding when the model call fails", async () => {
    create.mockRejectedValue(new Error("upstream down"));
    const fake = db({ identity: true });

    await handleSlackEvent(await installation(), mention(), deps(fake));

    expect(unlimited.record).toHaveBeenCalledWith(
      "ws-1",
      [{ kind: "embedding", model: "text-embedding-3-small", tokens: 40, purpose: "retrieval" }],
      { userId: "user-1" },
    );
    expect(posted().text).toMatch(/went wrong/i);
  });
});

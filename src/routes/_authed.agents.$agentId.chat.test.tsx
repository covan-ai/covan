import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * The chat screen, from the composer to the end of a reply.
 *
 * There was no test here at all, which is most of why the three defects this
 * file pins survived so long: every one of them is a frame of the interface
 * rather than a value a function returned, and none of them throws. The answer
 * blinked out and came back. The view stopped following a long reply. There
 * was no way back down once it had.
 *
 * The harness is large because this screen is: uploads, dictation, reports,
 * quota, an idea board and a realtime subscription all hang off it. None of
 * that is what these tests are about, so it is all stubbed down to nothing and
 * the stream is the only thing left moving.
 */

/**
 * The composer, by its placeholder. It says "Message" on an empty thread and
 * "Reply to" once there is something in it, and a test should not care which.
 */
function composerPlaceholder(name: string): RegExp {
  return new RegExp(`^(Message|Reply to) ${name}$`);
}

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useParams: () => ({ agentId: "agent-1" }),
    useSearch: () => ({ s: "session-1" }),
  }),
  useNavigate: () => navigate,
}));

const agent = {
  id: "agent-1",
  name: "GTM Agent",
  emoji: "📈",
  model: "gpt-4.1",
  mode: "normal" as const,
  // Can use it, cannot change it: the access most tests mean. Typed wide so a
  // test about uploading can make the reader an editor and put it back.
  myAccess: "use" as "use" | "edit" | "manage",
  documents: [] as {
    id: string;
    name: string;
    indexed: boolean;
    createdAt: number;
    bundleId?: string;
  }[],
};

const session = {
  id: "session-1",
  agentId: "agent-1",
  ownerId: "user-1",
  // Typed wide so a test about a shared thread, or a brainstorm, can turn
  // these and put them back.
  visibility: "private" as "private" | "shared",
  kind: "chat" as "chat" | "brainstorm",
  title: "Pricing",
  updatedAt: Date.parse("2026-09-17T10:00:00Z"),
  // The composer's dial, untouched: every one the agent's. Typed wide so a
  // test can turn one and put it back, the way `ownerId` is borrowed below.
  model: null as string | null,
  reasoningEffort: null as "minimal" | "low" | "medium" | "high" | null,
  webSearch: null as boolean | null,
  mode: null as "normal" | "brainstorm" | null,
};

const store = {
  agents: [agent],
  sessions: [session] as (typeof session)[],
  sessionsLoaded: true,
  startSession: vi.fn(),
  canWrite: true,
  // The folders the workspace can see, with whether each is shared. Empty
  // unless a test is about what a shared thread can read.
  bundles: [] as { id: string; name: string; shared?: boolean; mine?: boolean }[],
};
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

const listMessages = vi.fn();
const createMessage = vi.fn();
const showVersion = vi.fn();
const browserTasks = vi.fn();
const browserLive = vi.fn();
const takeoverCurrent = vi.fn();
const takeoverOpen = vi.fn();
const tuneSession = vi.fn();
const turnStatus = vi.fn();
const stopTurn = vi.fn();
const documentJobs = vi.fn();
const stopDocument = vi.fn();
/**
 * What `/me` answers. A variable rather than a literal so the dial's tests can
 * add `modelSpecs` — without it every model reads as one that does not
 * reason, which is the server's own answer for an id it does not know, and
 * the Thinking chip has nothing to show.
 */
const meDefault = { user: { id: "user-1" }, models: ["gpt-4.1", "claude-opus-5"] };
let meReply: Record<string, unknown> = meDefault;
vi.mock("@/lib/api-client", () => ({
  ApiError: class ApiError extends Error {
    status = 500;
  },
  getAccessToken: () => Promise.resolve("token"),
  // The empty screen builds a `src` for each connected app's mark with this.
  // Absent from the mock it is `undefined`, and every logo on that screen
  // throws before it can fall back to a monogram.
  assetSrc: (path: string) => (path ? `https://api.test${path}` : ""),
  api: {
    me: () => Promise.resolve(meReply),
    sessions: {
      messages: listMessages,
      setVisibility: vi.fn(),
      browserTasks,
      tune: tuneSession,
      turn: turnStatus,
      stopTurn,
      documentJobs,
    },
    documentJobs: { get: vi.fn(), stop: stopDocument, retry: vi.fn() },
    browser: { live: browserLive, takeOver: vi.fn(), handBack: vi.fn(), stop: vi.fn() },
    takeovers: { takeOver: vi.fn(), open: takeoverOpen, current: takeoverCurrent, close: vi.fn() },
    messages: {
      create: createMessage,
      update: vi.fn(),
      deleteAfter: vi.fn(),
      show: showVersion,
    },
    brainstorm: { suggest: vi.fn() },
    ideas: { create: vi.fn(), list: vi.fn().mockResolvedValue([]) },
    // Read only by the conversation the first run opened, for its Connect
    // card. Nothing connected, which is what a first run has.
    toolConnections: { list: () => Promise.resolve({ connections: [], tools: [] }) },
    connections: { list: () => Promise.resolve({ connections: [], providers: [] }) },
    slack: { get: () => Promise.resolve({ configured: false, installation: null }) },
  },
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: {
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), message: vi.fn() }),
}));

vi.mock("@/lib/credits", () => ({ useCredits: () => null, creditsSentence: () => "" }));
vi.mock("@/lib/use-chat-uploads", () => ({
  useChatUploads: () => ({ receipts: [], destinations: [], addFiles: vi.fn() }),
}));
vi.mock("@/lib/use-dictation", () => ({
  useDictation: () => ({ supported: false, recording: false, start: vi.fn(), stop: vi.fn() }),
  appendDictation: (draft: string) => draft,
}));
vi.mock("@/lib/use-report", () => ({
  useReportWriter: () => ({
    pending: false,
    dialogOpen: false,
    setDialogOpen: vi.fn(),
    write: vi.fn(),
  }),
}));

vi.mock("@/components/chat-attach", () => ({ ChatAttach: () => null, ChatReceipts: () => null }));
vi.mock("@/components/chat-report", () => ({ ChatReport: () => null }));
vi.mock("@/components/chat-mic", () => ({ ChatMic: () => null }));
vi.mock("@/components/feedback-dialog", () => ({ FeedbackDialog: () => null }));
vi.mock("@/components/idea-board", () => ({ IdeaBoard: () => null }));

/*
 * The connection hooks, mocked whole rather than served by a QueryClient.
 *
 * This file mocks `@/lib/api-client` by SHAPE — an object literal with the
 * handful of endpoints the chat uses — so the real hooks would call
 * `api.connections.list()` and find nothing there. Wrapping every render in a
 * provider to reach two queries that answer "nothing connected" in almost
 * every test here would be a lot of machinery for one default; the pattern is
 * `composio-card.test.tsx`'s.
 *
 * Empty by default, so the existing tests see exactly the screen they saw
 * before. The tests that care about connected apps override these.
 */
vi.mock("@/hooks/use-connections", () => ({
  useConnections: () => ({ data: { connections: [], providers: [] } }),
  useToolConnections: () => ({ data: { connections: [], tools: [] } }),
  // The keys the Connect card under an opening reads its connections by, and
  // the two hooks it connects with. Only the first run's conversation asks.
  toolConnectionsKey: ["tool-connections"],
  connectionsKey: ["connections"],
  slackKey: ["slack"],
  useConnectComposio: () => ({ mutate: vi.fn(), isPending: false }),
  useStartConnection: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/source-chip", () => ({ SourceChip: () => null }));

const question = {
  id: "msg-1",
  role: "user" as const,
  content: "What do we charge?",
  createdAt: Date.parse("2026-09-17T10:00:00Z"),
};

/**
 * A `fetch` that answers `/chat/stream` with the events given, as the real
 * endpoint frames them.
 *
 * Hand-rolled rather than a `Response`: the route reads four things off what
 * comes back — `status`, `ok`, `body.getReader()` and `json()` — and building
 * those directly keeps what the test controls visible in the test.
 */
function streamOf(events: Record<string, unknown>[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body, json: () => Promise.resolve(null) };
}

/**
 * The same, but left open, so a test can look at the screen mid-turn.
 *
 * `streamOf` enqueues everything and closes, which is all a test of the final
 * state needs. A tool turn's interesting moments are the gaps — the model
 * reading a result, saying nothing — and those only exist while the stream is
 * still running.
 */
function heldStreamOf(events: Record<string, unknown>[]) {
  const encoder = new TextEncoder();
  let push!: (event: Record<string, unknown>) => void;
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      for (const event of events) send(event);
      push = send;
      finish = () => controller.close();
    },
  });
  return {
    response: { ok: true, status: 200, body, json: () => Promise.resolve(null) },
    push,
    finish,
  };
}

const answer = {
  id: "msg-2",
  role: "assistant" as const,
  content: "Forty dollars a seat.",
  createdAt: Date.parse("2026-09-17T10:00:05Z"),
};

const { Route } = await import("./_authed.agents.$agentId.chat");
const ChatTab = (Route as unknown as { component: () => React.ReactElement }).component;

async function renderChat() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ChatTab />
    </QueryClientProvider>,
  );
  // Waits on the share toggle rather than the composer, which renders before
  // anything has loaded. The toggle needs `isOwner`, which needs `/me` — so by
  // the time it is on screen both queries have settled and the shortcuts that
  // turn on ownership behave the way they will in a browser.
  await screen.findByPlaceholderText(composerPlaceholder(agent.name));
  await screen.findByRole("button", { name: /Private to you|Shared with your workspace/ });
  return { ...view, client };
}

/** Opens the conversation search and hands back the field. */
async function openSearch() {
  await userEvent.click(screen.getByRole("button", { name: "Search this conversation" }));
  return screen.getByPlaceholderText("Search this conversation");
}

/** The scrolling element, which has no other handle on it. */
const scroller = (container: HTMLElement) =>
  container.querySelector(".overflow-y-auto") as HTMLElement;

/**
 * Put the scroll box somewhere and say so, the way a browser would.
 *
 * jsdom lays nothing out, so all three of these read zero and every box looks
 * like it is at its own bottom. `isPinnedToBottom` is real in these tests, so
 * the numbers have to be.
 */
function place(el: HTMLElement, { scrollTop, scrollHeight, clientHeight }: Record<string, number>) {
  for (const [name, value] of Object.entries({ scrollTop, scrollHeight, clientHeight })) {
    Object.defineProperty(el, name, { value, configurable: true, writable: true });
  }
  el.dispatchEvent(new Event("scroll"));
}

/**
 * Whether this is a phone, which is the one thing Enter's meaning turns on.
 *
 * A local stub rather than one in `test-setup.ts`, for the reason
 * `theme.test.tsx` gives for its own: a global would let a later test rely on
 * media queries working without ever saying that it does.
 */
let onAPhone = false;
const stubMatchMedia = () => {
  window.matchMedia = ((query: string) => ({
    matches: onAPhone,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
};

/** A reply that starts and does not finish, for anything about stopping one. */
function openStream() {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"type":"delta","text":"Forty"}\n\n`));
    },
  });
  return { ok: true, status: 200, body, json: () => Promise.resolve(null) };
}

let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  meReply = meDefault;
  onAPhone = false;
  stubMatchMedia();
  listMessages.mockResolvedValue([question]);
  createMessage.mockResolvedValue(question);
  // No turn running on the server, and a stop that finds one and keeps nothing.
  turnStatus.mockResolvedValue({ turn: null });
  stopTurn.mockResolvedValue({ stopped: true, message: null });
  // No browser beside the conversation, which is almost every conversation.
  browserTasks.mockResolvedValue({ tasks: [], session: null, events: [], delivered: false });
  browserLive.mockResolvedValue({ liveUrl: "https://live.example/view", liveState: "agent" });
  takeoverCurrent.mockResolvedValue({ takeover: null });
  // No documents in it either.
  documentJobs.mockResolvedValue([]);
  stopDocument.mockResolvedValue(undefined);
  // jsdom implements no scrolling at all, so the component's own call is the
  // only evidence of what it asked for.
  scrollTo = vi.fn();
  Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the end of a reply", () => {
  it("shows the answer the stream handed over, without waiting for a refetch", async () => {
    // The defect this pins: `done` carries the row the server has just written,
    // and the route used to drop it and ask for the message list again. The
    // streamed text is cleared in the same breath, so for one round trip the
    // answer was on screen nowhere — it blinked out and back, every turn.
    //
    // The refetch here never resolves, which is the whole test: if the answer
    // is on screen, it got there from the stream.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            { type: "delta", text: "Forty dollars" },
            { type: "delta", text: " a seat." },
            { type: "done", message: answer },
          ]),
        ),
      ),
    );

    const { client } = await renderChat();
    listMessages.mockReturnValue(new Promise(() => {}));

    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "and per seat?",
    );
    await userEvent.click(screen.getByLabelText("Send message"));

    await screen.findByText("Forty dollars a seat.");
    // And it is in the cache, not just in the streaming block — the block
    // unmounts the moment the stream ends, so anything still rendered came
    // from the list.
    await waitFor(() => {
      const cached = client.getQueryData(["messages", "session-1"]) as { id: string }[];
      expect(cached.map((m) => m.id)).toContain("msg-2");
    });
    expect(screen.getByText("Forty dollars a seat.")).toBeInTheDocument();
  });

  it("survives a done event with no message on it", async () => {
    // Older workers, and any future one that stops sending the row. The answer
    // is then the refetch's job again, which is what this used to be always.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamOf([{ type: "delta", text: "Forty." }, { type: "done" }]))),
    );

    await renderChat();
    // With nothing handed over, the refetch is the only thing that can supply
    // the answer — which is what this path was, always, before the stream
    // started carrying it.
    listMessages.mockResolvedValue([question, answer]);

    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "and per seat?",
    );
    await userEvent.click(screen.getByLabelText("Send message"));

    expect(await screen.findByText("Forty dollars a seat.")).toBeInTheDocument();
  });
});

describe("following a reply down the page", () => {
  it("scrolls instantly rather than smoothly", async () => {
    // A smooth scroll is an animation that outlives the token that started it.
    // The follow effect refires on every token, so each one restarted the
    // animation, and while it was in flight the box sat far enough from the
    // bottom that the scroll listener read it as the reader having scrolled
    // away — after which nothing followed the rest of the answer.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            { type: "delta", text: "Forty." },
            { type: "done", message: answer },
          ]),
        ),
      ),
    );

    await renderChat();
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    for (const call of scrollTo.mock.calls) {
      expect(call[0].behavior).toBe("auto");
    }
  });
});

describe("the way back down", () => {
  it("offers a way back only once the reader has left the bottom", async () => {
    const { container } = await renderChat();
    expect(screen.queryByLabelText("Jump to the latest message")).not.toBeInTheDocument();

    act(() => place(scroller(container), { scrollTop: 0, scrollHeight: 4000, clientHeight: 600 }));

    expect(screen.getByLabelText("Jump to the latest message")).toBeInTheDocument();
  });

  it("goes back to the end and starts following again", async () => {
    const { container } = await renderChat();
    const el = scroller(container);
    act(() => place(el, { scrollTop: 0, scrollHeight: 4000, clientHeight: 600 }));

    scrollTo.mockClear();
    await userEvent.click(screen.getByLabelText("Jump to the latest message"));

    expect(scrollTo).toHaveBeenCalledWith({ top: 4000, behavior: "auto" });
    expect(screen.queryByLabelText("Jump to the latest message")).not.toBeInTheDocument();
  });

  it("stays out of the way while the conversation is empty", async () => {
    listMessages.mockResolvedValue([]);
    const { container } = await renderChat();
    act(() => place(scroller(container), { scrollTop: 0, scrollHeight: 4000, clientHeight: 600 }));

    expect(screen.queryByLabelText("Jump to the latest message")).not.toBeInTheDocument();
  });
});

describe("what Enter means", () => {
  const composer = () => screen.getByPlaceholderText(composerPlaceholder(agent.name));

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            { type: "delta", text: "Forty dollars a seat." },
            { type: "done", message: answer },
          ]),
        ),
      ),
    );
  });

  it("sends, at a keyboard", async () => {
    await renderChat();
    await userEvent.type(composer(), "and per seat?{Enter}");

    await waitFor(() => expect(createMessage).toHaveBeenCalled());
  });

  it("does not send a word an IME is still offering", async () => {
    // An IME takes Enter to mean "accept the suggestion". Without this guard a
    // Japanese, Chinese or Korean sentence posted itself one word in — and the
    // half-written question is then what the agent answers.
    await renderChat();
    await userEvent.type(composer(), "日本");
    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true });

    expect(createMessage).not.toHaveBeenCalled();
  });

  it("starts a new line on a phone, where it is the newline key", async () => {
    onAPhone = true;
    await renderChat();
    await userEvent.type(composer(), "and per seat?{Enter}");

    expect(createMessage).not.toHaveBeenCalled();
    expect(composer()).toHaveValue("and per seat?\n");
  });

  it("sends on a phone when it is asked to, with a modifier", async () => {
    onAPhone = true;
    await renderChat();
    await userEvent.type(composer(), "and per seat?");
    fireEvent.keyDown(composer(), { key: "Enter", metaKey: true });

    await waitFor(() => expect(createMessage).toHaveBeenCalled());
  });
});

describe("the composer's actions", () => {
  it("says what the send button is waiting for, where a touch screen can see it", async () => {
    // It said it in a `title`, which never appears on a touch screen at all —
    // on a phone the button simply looked broken while a reply ran. There was
    // no tooltip on this row before the composer was rebuilt.
    await renderChat();
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "and per seat?",
    );

    await userEvent.hover(screen.getByLabelText("Send message"));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Send message");
  });
});

describe("the keys beside Enter", () => {
  const composer = () => screen.getByPlaceholderText(composerPlaceholder(agent.name));

  it("stops a running reply on Escape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(openStream())),
    );
    await renderChat();

    await userEvent.type(composer(), "and per seat?{Enter}");
    await screen.findByLabelText("Stop generating");

    fireEvent.keyDown(composer(), { key: "Escape" });

    await waitFor(() => expect(screen.queryByLabelText("Stop generating")).not.toBeInTheDocument());
  });

  it("opens the last thing you said on an empty composer and the up arrow", async () => {
    await renderChat();
    fireEvent.keyDown(composer(), { key: "ArrowUp" });

    expect(await screen.findByLabelText("Edit your message")).toHaveValue(question.content);
  });

  it("leaves the arrow alone once there is a draft to move around in", async () => {
    // The shortcut is for an empty box. With something typed, up is how you
    // get to the line above it.
    await renderChat();
    await userEvent.type(composer(), "half a thought");
    fireEvent.keyDown(composer(), { key: "ArrowUp" });

    expect(screen.queryByLabelText("Edit your message")).not.toBeInTheDocument();
  });
});

describe("what a reply looks like on its way in", () => {
  it("renders the markdown as it arrives, not once it has finished", async () => {
    // What this used to be: raw `**`, bare `|` rows and an unopened fence on
    // screen for the length of the answer, then the whole thing reflowing into
    // something else the moment `done` landed. The reflow was the most visible
    // difference between this and the chat products people arrive from.
    const held = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const text of ["## Pricing\n\n", "**Forty** dollars", " a seat."]) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "delta", text })}\n\n`),
          );
        }
        // Left open: this is the middle of a reply, which is the whole point.
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200, body: held, json: async () => null })),
    );

    const { container } = await renderChat();
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );

    await waitFor(() => expect(container.querySelector("strong")).toBeInTheDocument());
    expect(container.querySelector("strong")).toHaveTextContent("Forty");
    const answer = container.querySelector('[data-turn="answer"]') as HTMLElement;
    expect(within(answer).getByText("Pricing")).toBeInTheDocument();
    // And nothing on screen still shows the marks themselves.
    expect(screen.queryByText(/\*\*Forty\*\*/)).not.toBeInTheDocument();
  });

  it("carries the caret while the reply is arriving, and drops it after", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(openStream())),
    );
    const { container } = await renderChat();
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );

    await waitFor(() => expect(container.querySelector(".stream-live")).toBeInTheDocument());

    fireEvent.keyDown(screen.getByPlaceholderText(composerPlaceholder(agent.name)), {
      key: "Escape",
    });

    // Stopped: the text stays until the server's copy replaces it, but it is
    // no longer arriving, so it no longer claims to be.
    await waitFor(() => expect(container.querySelector(".stream-live")).not.toBeInTheDocument());
  });
});

/**
 * A turn runs on the server now, whoever is watching it.
 *
 * Two things that used to be lost: the words a person stopped, which were
 * wiped from the screen on a 700ms timer and came back only if the server had
 * already saved them; and the answer being written while the person was in
 * another conversation, which was simply never finished.
 */
describe("a turn that outlives the screen", () => {
  const composer = () => screen.getByPlaceholderText(composerPlaceholder(agent.name));

  it("keeps the words a person stopped, and asks the server to stop the turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(openStream())),
    );
    // The server is still saving when it answers: nothing kept yet.
    stopTurn.mockResolvedValue({ stopped: true, message: null });
    await renderChat();

    await userEvent.type(composer(), "how much?{Enter}");
    await screen.findByText("Forty");
    fireEvent.keyDown(composer(), { key: "Escape" });

    await waitFor(() => expect(stopTurn).toHaveBeenCalledWith("session-1"));
    expect(await screen.findByText("You stopped this answer.")).toBeInTheDocument();
    // Long past the 700ms the words used to last.
    await act(() => new Promise((r) => setTimeout(r, 900)));
    expect(screen.getByText("Forty")).toBeInTheDocument();
  });

  it("puts the row the server kept where the stopped words were", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(openStream())),
    );
    const kept = {
      id: "msg-kept",
      role: "assistant" as const,
      content: "Forty",
      createdAt: Date.parse("2026-09-17T10:00:05Z"),
      outcome: "stopped",
    };
    stopTurn.mockResolvedValue({ stopped: true, message: kept });
    await renderChat();

    await userEvent.type(composer(), "how much?{Enter}");
    await screen.findByText("Forty");
    listMessages.mockResolvedValue([question, kept]);
    fireEvent.keyDown(composer(), { key: "Escape" });

    // Once, as the stored reply's own line rather than beside a second copy.
    await waitFor(() => expect(screen.getAllByText("Forty")).toHaveLength(1));
    expect(screen.getAllByText("You stopped this answer.")).toHaveLength(1);
  });

  it("picks up the answer still being written when the conversation is opened again", async () => {
    turnStatus.mockResolvedValue({ turn: { running: true, mine: true, startedAt: 0 } });
    const fetchMock = vi.fn(() => Promise.resolve(openStream()));
    vi.stubGlobal("fetch", fetchMock);

    await renderChat();

    expect(await screen.findByText("Forty")).toBeInTheDocument();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(
      /\/sessions\/session-1\/turn\/stream$/,
    );
    expect(screen.getByLabelText("Stop generating")).toBeInTheDocument();
  });

  it("leaves somebody else's turn alone in a shared conversation", async () => {
    turnStatus.mockResolvedValue({ turn: { running: true, mine: false, startedAt: 0 } });
    const fetchMock = vi.fn(() => Promise.resolve(openStream()));
    vi.stubGlobal("fetch", fetchMock);

    await renderChat();
    await waitFor(() => expect(turnStatus).toHaveBeenCalledWith("session-1"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Stop generating")).not.toBeInTheDocument();
  });
});

/**
 * covan-ai/covan#350. A turn the model provider refused used to end in a row
 * that offered "Try again" whatever the reason, and on a reload in nothing at
 * all: the question sat there looking like one still being answered.
 */
describe("a question the model did not answer", () => {
  it("offers no Try again when the server says trying again cannot help", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            {
              type: "error",
              error: "The model is unavailable right now.",
              code: "quota",
              retryable: false,
            },
          ]),
        ),
      ),
    );
    await renderChat();
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "how much?{Enter}",
    );

    expect(await screen.findByText("The model is unavailable right now.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("still offers it when the far end only had a bad minute", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            { type: "error", error: "The model didn't answer this time.", retryable: true },
          ]),
        ),
      ),
    );
    await renderChat();
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "how much?{Enter}",
    );

    expect(await screen.findByText("The model didn't answer this time.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("says so after a reload, once the server says no turn is running", async () => {
    turnStatus.mockResolvedValue({ turn: null, hosted: true });
    const fetchMock = vi.fn(() => Promise.resolve(openStream()));
    vi.stubGlobal("fetch", fetchMock);
    await renderChat();

    expect(await screen.findByText("This question didn't get an answer.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/chat\/stream$/);
  });

  it("says nothing while somebody else's turn is still answering it", async () => {
    turnStatus.mockResolvedValue({
      turn: { running: true, mine: false, startedAt: 0 },
      hosted: true,
    });
    await renderChat();
    await waitFor(() => expect(turnStatus).toHaveBeenCalledWith("session-1"));

    expect(screen.queryByText("This question didn't get an answer.")).not.toBeInTheDocument();
  });

  it("says nothing about a question asked since the server was asked", async () => {
    // The server's "no turn" is only evidence about what was there before it
    // answered. A question newer than that may be another person's, running.
    listMessages.mockResolvedValue([{ ...question, createdAt: Date.now() + 60_000 }]);
    turnStatus.mockResolvedValue({ turn: null, hosted: true });
    await renderChat();
    await waitFor(() => expect(turnStatus).toHaveBeenCalledWith("session-1"));

    expect(screen.queryByText("This question didn't get an answer.")).not.toBeInTheDocument();
  });
});

describe("what a screen reader is told", () => {
  it("reads the transcript as a log, and only what is added to it", async () => {
    await renderChat();

    const log = screen.getByRole("log", { name: "Conversation" });
    expect(within(log).getByText(question.content)).toBeInTheDocument();
    // Not `additions text`, which is the default: an edited message rewrites
    // text already read out, and re-reading it is nobody's request.
    expect(log).toHaveAttribute("aria-relevant", "additions");
  });

  it("says a reply is coming without reading it a token at a time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(openStream())),
    );
    await renderChat();

    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );

    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(`${agent.name} is replying`));
    // And the words themselves are outside the log, so they are not announced
    // again on every delta.
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(within(log).queryByText(/Forty/)).not.toBeInTheDocument();
  });

  it("falls quiet once nothing is arriving", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            { type: "delta", text: "Forty." },
            { type: "done", message: answer },
          ]),
        ),
      ),
    );
    await renderChat();
    // What the server returns once the answer is written — the refetch that
    // follows `done` reads this, and without it the mock would hand back a
    // list from before the reply and take the answer straight back off screen.
    listMessages.mockResolvedValue([question, answer]);

    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );

    await waitFor(() => expect(screen.getByRole("status")).toBeEmptyDOMElement());
    // The answer is in the log by then, which is where it gets read out.
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(within(log).getByText(answer.content)).toBeInTheDocument();
  });
});

describe("a conversation longer than one page", () => {
  const manyMessages = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `msg-${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn ${i}`,
      createdAt: Date.parse("2026-09-17T10:00:00Z") + i * 1000,
    }));

  it("asks for a page, and says so when there is more behind it", async () => {
    listMessages.mockResolvedValue(manyMessages(100));
    await renderChat();

    expect(listMessages).toHaveBeenCalledWith("session-1", { limit: 100 });
    expect(screen.getByRole("button", { name: "Load earlier messages" })).toBeInTheDocument();
  });

  it("offers nothing to load when the whole conversation already fits", async () => {
    listMessages.mockResolvedValue(manyMessages(12));
    await renderChat();

    expect(screen.queryByRole("button", { name: "Load earlier messages" })).not.toBeInTheDocument();
  });

  it("asks for a deeper page, and keeps it for the refetch after the next reply", async () => {
    listMessages.mockResolvedValue(manyMessages(100));
    await renderChat();

    listMessages.mockResolvedValue(manyMessages(200));
    await userEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));

    await waitFor(() => expect(listMessages).toHaveBeenCalledWith("session-1", { limit: 200 }));

    // And the depth survives a turn: the refetch that follows a reply used to
    // snap back to the first page and throw the scrollback away.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            { type: "delta", text: "Forty." },
            { type: "done", message: answer },
          ]),
        ),
      ),
    );
    listMessages.mockClear();
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );

    await waitFor(() => expect(listMessages).toHaveBeenCalledWith("session-1", { limit: 200 }));
    // Fifteen seconds rather than the default five, and it is the work rather
    // than a hang: this renders two hundred messages and then types a sentence
    // into them, so every keystroke re-renders the list. It passed alone and
    // lost the race whenever the suite was busy — which made it look like a
    // flake in the product and was a timeout too tight for what it does.
  }, 15_000);
});

describe("an answer that stopped at its length limit", () => {
  const cutOff = { ...answer, content: "Forty dollars a seat, and the volume rule is" };

  const truncatedReply = () =>
    streamOf([
      { type: "delta", text: cutOff.content },
      { type: "truncated" },
      { type: "done", message: cutOff },
    ]);

  it("says so under the answer, and keeps saying it", async () => {
    // This was a toast, which is gone in four seconds and leaves a
    // half-finished answer sitting there looking whole.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(truncatedReply())),
    );
    await renderChat();
    listMessages.mockResolvedValue([question, cutOff]);

    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );

    expect(await screen.findByText("This answer hit its length limit.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("asks the server to finish the reply rather than answer again", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(truncatedReply()));
    vi.stubGlobal("fetch", fetchMock);
    await renderChat();
    listMessages.mockResolvedValue([question, cutOff]);
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );
    await screen.findByRole("button", { name: "Continue" });

    fetchMock.mockClear();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        streamOf([
          { type: "delta", text: " two seats free." },
          { type: "done", message: { ...cutOff, content: `${cutOff.content} two seats free.` } },
        ]),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ sessionId: "session-1", continue: true });
  });

  it("grows the answer in place rather than starting a second one", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(truncatedReply()));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await renderChat();
    listMessages.mockResolvedValue([question, cutOff]);
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );
    await screen.findByRole("button", { name: "Continue" });

    const whole = `${cutOff.content} two seats free.`;
    listMessages.mockResolvedValue([question, { ...cutOff, content: whole }]);
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        streamOf([
          { type: "delta", text: " two seats free." },
          { type: "done", message: { ...cutOff, content: whole } },
        ]),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    // One reply, holding both halves — not two replies that silently become
    // one when the stream ends.
    await waitFor(() => expect(screen.getByText(whole)).toBeInTheDocument());
    expect(container.querySelectorAll(`[data-turn="answer"]`).length).toBe(1);
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });
});

describe("a reply refused for credits", () => {
  const refused = () =>
    new Response(JSON.stringify({ error: "credits_exhausted", balance: 0 }), { status: 402 });

  it("says so under the message, with the next step, and stops the next send", async () => {
    // This was a four-second toast; the question then sat with nothing under
    // it, and the composer invited a second one into the same refusal.
    const fetchMock = vi.fn(() => Promise.resolve(refused()));
    vi.stubGlobal("fetch", fetchMock);
    await renderChat();
    listMessages.mockResolvedValue([question]);
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );

    expect(
      await screen.findByText(/out of credits, so this message has no reply yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(composerPlaceholder(agent.name)), "and now?");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await userEvent.keyboard("{Enter}");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("an answer that stopped at a ceiling", () => {
  const partial = { ...answer, content: "I checked three of the repositories." };

  /** A turn that answered, but stopped because it ran out of something. */
  const stoppedBy = (reason: "budget" | "tokens" | "credits") =>
    streamOf([
      { type: "delta", text: partial.content },
      { type: "paused", reason },
      { type: "done", message: partial },
    ]);

  const ask = async () =>
    userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );

  it("says so under the answer, and keeps saying it", async () => {
    // This was a four-second toast over a reply that looked finished — gone
    // before the person had read the answer it was about, and with nothing to
    // press. The same argument the length-limit row above was written from.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(stoppedBy("budget"))),
    );
    await renderChat();
    listMessages.mockResolvedValue([question, partial]);
    await ask();

    expect(
      await screen.findByText("This turn used every tool call it is allowed."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep going" })).toBeInTheDocument();
  });

  it("says the workspace ran out of credit, and offers nothing that would be refused", async () => {
    // Checked before every step now, not only before the first. Keep going
    // would meet the same empty balance, so the line says why and stops there.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(stoppedBy("credits"))),
    );
    await renderChat();
    listMessages.mockResolvedValue([question, partial]);
    await ask();

    expect(
      await screen.findByText("This workspace ran out of credits partway through this answer."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep going" })).not.toBeInTheDocument();
  });

  it("names the ceiling it actually hit", async () => {
    // Running out of tool calls and running out of tokens ask the person to
    // narrow different things — fewer things at once, or less material.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(stoppedBy("tokens"))),
    );
    await renderChat();
    listMessages.mockResolvedValue([question, partial]);
    await ask();

    expect(
      await screen.findByText("This turn reached the most one answer is allowed to spend."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("This turn used every tool call it is allowed."),
    ).not.toBeInTheDocument();
  });

  it("says so after a reload, from what the reply recorded", async () => {
    // #248: the stream that said so live is gone after a reload, and the reply
    // looked whole again. `messages.outcome` is what remembers.
    listMessages.mockResolvedValue([question, { ...partial, outcome: "tokens" }]);
    await renderChat();

    expect(
      await screen.findByText("This turn reached the most one answer is allowed to spend."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep going" })).toBeInTheDocument();
  });

  it("not under an older reply", async () => {
    // A reply that was followed by something is one the person already moved
    // past; offering to keep it going there would continue the wrong turn.
    const at = (seconds: number) => Date.parse("2026-09-17T10:00:00Z") + seconds * 1000;
    listMessages.mockResolvedValue([
      question,
      { ...partial, outcome: "budget" },
      { ...question, id: "msg-3", content: "and now?", createdAt: at(10) },
      { ...answer, id: "msg-4", content: "Two seats are free.", createdAt: at(15) },
    ]);
    await renderChat();

    expect(await screen.findByText("Two seats are free.")).toBeInTheDocument();
    expect(
      screen.queryByText("This turn used every tool call it is allowed."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep going" })).not.toBeInTheDocument();
  });

  it("asks again as a new turn, not as a hidden continuation", async () => {
    // The turn is over and its budget is spent, so carrying on is a person
    // deciding to spend more: a fresh ceiling, the transcript read again, and a
    // visible record that somebody asked. `continue: true` would be none of
    // those — it appends to the same row under a length-cap instruction that
    // is not what happened.
    const fetchMock = vi.fn(() => Promise.resolve(stoppedBy("budget")));
    vi.stubGlobal("fetch", fetchMock);
    await renderChat();
    listMessages.mockResolvedValue([question, partial]);
    await ask();
    await screen.findByRole("button", { name: "Keep going" });

    fetchMock.mockClear();
    fetchMock.mockImplementation(() =>
      Promise.resolve(streamOf([{ type: "delta", text: "and the rest." }, { type: "done" }])),
    );
    await userEvent.click(screen.getByRole("button", { name: "Keep going" }));

    // The message goes through the ordinary send path, so the first call is
    // the user turn being written rather than a stream request carrying a flag.
    const streamCall = fetchMock.mock.calls.find((call) =>
      String((call as unknown as [string])[0]).includes("/chat/stream"),
    ) as unknown as [string, RequestInit] | undefined;
    const body = JSON.parse((streamCall?.[1].body as string) ?? "{}");
    expect(body.continue).toBeUndefined();
    expect(body.sessionId).toBe("session-1");
  });
});

describe("the pause before an answer", () => {
  it("shows what the model is working through, open while it works", async () => {
    // On a reasoning model at a real effort there is a long silence before the
    // first word, and a silence is indistinguishable from a product that has
    // stopped working.
    const held = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of [
          { type: "thinking", text: "The handbook says forty" },
          { type: "thinking", text: " — check the volume rule." },
        ]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200, body: held, json: async () => null })),
    );

    const { container } = await renderChat();
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );

    // This asserted a CLOSED `<details>` until the reasoning block arrived:
    // the reader got the word "Thinking" and nothing else, with no sign of
    // whether it was still happening. §2 of the design overturns that — it is
    // open while the reasoning arrives and folds itself the moment it stops.
    const fold = await waitFor(() => {
      const el = screen.getByRole("button", { name: /Thinking/ });
      expect(el).toHaveAttribute("aria-expanded", "true");
      return el;
    });

    // The trigger and the reasoning are siblings inside the block.
    expect(fold.parentElement).toHaveTextContent(
      "The handbook says forty — check the volume rule.",
    );
    // And the typing dots have nothing left to say once the model is saying it.
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  });

  it("keeps the reasoning out of the answer", async () => {
    // Two different things going to two different places. A client that cannot
    // tell them apart writes an account of the model's deliberation into the
    // transcript.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            { type: "thinking", text: "Checking the handbook." },
            { type: "delta", text: "Forty dollars a seat." },
            { type: "done", message: answer },
          ]),
        ),
      ),
    );

    await renderChat();
    listMessages.mockResolvedValue([question, answer]);
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder(agent.name)),
      "how much?{Enter}",
    );

    const settled = await screen.findByText("Forty dollars a seat.");
    expect(settled).not.toHaveTextContent("Checking the handbook");
    // And it goes with the stream: the row does not carry it, so leaving it on
    // screen would be showing something the transcript does not contain.
    await waitFor(() => expect(screen.queryByText("Thinking")).not.toBeInTheDocument());
  });
});

describe("an answer that was asked for twice", () => {
  const versioned = { ...answer, versions: ["v1", "msg-2"] };

  it("says which take is showing, and offers the others", async () => {
    listMessages.mockResolvedValue([question, versioned]);
    await renderChat();

    expect(await screen.findByLabelText("Version 2 of 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Previous version of this answer")).toBeEnabled();
    expect(screen.getByLabelText("Next version of this answer")).toBeDisabled();
  });

  it("goes back to the one that was put aside", async () => {
    listMessages.mockResolvedValue([question, versioned]);
    showVersion.mockResolvedValue({ ok: true });
    await renderChat();

    await userEvent.click(await screen.findByLabelText("Previous version of this answer"));

    expect(showVersion).toHaveBeenCalledWith("v1");
  });

  it("says nothing at all about versions on an answer with one", async () => {
    listMessages.mockResolvedValue([question, answer]);
    await renderChat();

    expect(screen.queryByLabelText(/Version \d+ of/)).not.toBeInTheDocument();
  });

  it("asks the server to answer again rather than deleting first", async () => {
    // What this used to do: `deleteAfter`, then a fresh stream, with no way
    // back to the answer that was there.
    const fetchMock = vi.fn(() =>
      Promise.resolve(streamOf([{ type: "delta", text: "Again." }, { type: "done" }])),
    );
    vi.stubGlobal("fetch", fetchMock);
    listMessages.mockResolvedValue([question, answer]);
    await renderChat();

    await userEvent.click(await screen.findByLabelText("Regenerate"));

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: "session-1",
      regenerate: true,
    });
  });

  it("can answer again on another model, for that reply only", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(streamOf([{ type: "delta", text: "Again." }, { type: "done" }])),
    );
    vi.stubGlobal("fetch", fetchMock);
    listMessages.mockResolvedValue([question, answer]);
    await renderChat();

    await userEvent.click(await screen.findByLabelText("Answer again on another model"));
    await userEvent.click(await screen.findByText("claude-opus-5"));

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: "session-1",
      regenerate: true,
      model: "claude-opus-5",
    });
  });
});

describe("finding what was said", () => {
  const older = {
    id: "msg-3",
    role: "assistant" as const,
    content: "Twenty days, plus up to five can roll over.",
    createdAt: Date.parse("2026-09-17T09:00:00Z"),
  };

  it("filters the conversation to what matches the search", async () => {
    listMessages.mockResolvedValue([older, question, answer]);
    await renderChat();

    const box = await openSearch();
    await userEvent.type(box, "roll");

    await waitFor(() => {
      expect(screen.getByText(/Twenty days, plus up to five can roll over/)).toBeInTheDocument();
      expect(screen.queryByText("What do we charge?")).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText("1 of 3 messages match")).toBeInTheDocument();
  });

  it("says how many matched, or that nothing did", async () => {
    listMessages.mockResolvedValue([question, answer]);
    await renderChat();

    await userEvent.type(await openSearch(), "vacation");

    await waitFor(() =>
      expect(screen.getByText(/Nothing in this conversation matches/)).toBeInTheDocument(),
    );
  });

  it("clears the search on Escape", async () => {
    listMessages.mockResolvedValue([older, question, answer]);
    await renderChat();

    const box = await openSearch();
    await userEvent.type(box, "roll");
    await waitFor(() => expect(screen.getByLabelText("1 of 3 messages match")).toBeInTheDocument());

    fireEvent.keyDown(box, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByLabelText("1 of 3 messages match")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/What do we charge/)).toBeInTheDocument();
  });
});

/**
 * The three frames the harness added, from the screen's side.
 *
 * All three are new, which means every client older than them ignores them —
 * the dispatch chain drops a `type` it cannot name, and has since it was
 * written. That is worth a test of its own, because it is the property that
 * lets a worker ship ahead of a browser tab somebody left open.
 */
describe("a reply that used a tool", () => {
  it("shows what it is doing, then what it did", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            {
              type: "step",
              index: 0,
              tool: "query_database",
              status: "running",
              label: "query_database · select count(*) from orders",
            },
            {
              type: "step",
              index: 0,
              tool: "query_database",
              status: "ok",
              label: "query_database · select count(*) from orders",
            },
            { type: "delta", text: "Forty." },
            { type: "done", message: answer },
          ]),
        ),
      ),
    );

    await renderChat();
    listMessages.mockReturnValue(new Promise(() => {}));

    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "how many orders?",
    );
    await userEvent.click(screen.getByLabelText("Send message"));

    // The same index arriving twice is one row changing, not two rows.
    await screen.findByText("Forty dollars a seat.");
  });

  it("ignores a step status it has no word for, rather than breaking the turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            { type: "step", index: 0, tool: "t", status: "teleporting", label: "t" },
            // And a whole frame type this build has never heard of.
            { type: "something-from-a-newer-worker", payload: 1 },
            { type: "delta", text: "Forty." },
            { type: "done", message: answer },
          ]),
        ),
      ),
    );

    await renderChat();
    listMessages.mockReturnValue(new Promise(() => {}));

    await userEvent.type(screen.getByPlaceholderText(composerPlaceholder("GTM Agent")), "go");
    await userEvent.click(screen.getByLabelText("Send message"));

    await screen.findByText("Forty dollars a seat.");
  });
});

/**
 * Whether the screen looks alive between one tool call and the next.
 *
 * A tool turn goes quiet repeatedly: every pass after the first starts with
 * the model reading a result, which takes seconds and produces nothing. The
 * dots used to go out on the first step and never come back, which was barely
 * noticeable at two steps and reads as a frozen page at sixteen.
 */
describe("the sign of life during a long turn", () => {
  async function sendAnd(frames: Record<string, unknown>[]) {
    const held = heldStreamOf(frames);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(held.response)),
    );
    await renderChat();
    listMessages.mockReturnValue(new Promise(() => {}));
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "how many orders?",
    );
    await userEvent.click(screen.getByLabelText("Send message"));
    return held;
  }

  const running = { type: "step", index: 0, tool: "run_tool", status: "running", label: "run" };
  const settled = { type: "step", index: 0, tool: "run_tool", status: "ok", label: "run" };

  it("goes quiet while a tool is running, because the row says what is happening", async () => {
    const held = await sendAnd([running]);
    await waitFor(() => expect(screen.queryByText("Thinking…")).not.toBeInTheDocument());
    held.finish();
  });

  it("comes back once the tool has landed and the model is reading it", async () => {
    const held = await sendAnd([running, settled]);
    // The row now describes something that already finished. Nothing on
    // screen explains the wait that follows, which is what the dots are for.
    await screen.findByText("Thinking…");
    held.finish();
  });

  it("goes out again the moment the model starts writing", async () => {
    const held = await sendAnd([running, settled]);
    await screen.findByText("Thinking…");
    held.push({ type: "delta", text: "Forty." });
    await waitFor(() => expect(screen.queryByText("Thinking…")).not.toBeInTheDocument());
    held.finish();
  });

  it("keeps the words already written while it waits for the next pass", async () => {
    // The regression this guards: the dots and the streamed text used to be
    // two branches of one ternary, so bringing the dots back mid-turn would
    // have taken the first pass's words off the screen.
    const held = await sendAnd([{ type: "delta", text: "Let me look." }, running, settled]);
    await screen.findByText("Thinking…");
    expect(screen.getByText("Let me look.")).toBeInTheDocument();
    held.finish();
  });

  it("stays out when the turn is waiting for a person rather than working", async () => {
    // `pending` is the turn stopping to ask. Dots under a confirmation card
    // would say the machine is busy when it is waiting on somebody.
    const held = await sendAnd([
      running,
      { type: "step", index: 0, tool: "run_tool", status: "pending", label: "run" },
    ]);
    await waitFor(() => expect(screen.queryByText("Thinking…")).not.toBeInTheDocument());
    held.finish();
  });
});

describe("a reply that stopped to ask", () => {
  const confirmFrames = [
    { type: "delta", text: "I can set that up." },
    {
      type: "confirm",
      id: "paused-1",
      tool: "schedule_job",
      summary: "Create a routine on 0 17 * * 1?",
      proposal: { kind: "schedule_job", name: "Monday orders", cron: "0 17 * * 1" },
    },
    { type: "paused", reason: "confirmation" },
    { type: "done", message: answer },
  ];

  it("puts the question on screen with what it would do", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamOf(confirmFrames))),
    );

    await renderChat();
    listMessages.mockReturnValue(new Promise(() => {}));

    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "every monday",
    );
    await userEvent.click(screen.getByLabelText("Send message"));

    await screen.findByText("Create a routine on 0 17 * * 1?");
    expect(screen.getByText("Monday orders")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  /**
   * Declining is not closing the card. It goes to the same endpoint with
   * `approve: false`, so the agent is told and finishes its turn — the
   * alternative leaves the conversation ending mid-sentence with a parked
   * turn nobody ever answers.
   */
  it("reports both answers to the worker, at the confirm endpoint", async () => {
    const fetchMock = vi.fn((url: string, init?: { body?: string }) => {
      void init;
      return Promise.resolve(
        url.includes("/chat/confirm/")
          ? streamOf([
              { type: "delta", text: " Not doing it." },
              { type: "done", message: answer },
            ])
          : streamOf(confirmFrames),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderChat();
    listMessages.mockReturnValue(new Promise(() => {}));

    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "every monday",
    );
    await userEvent.click(screen.getByLabelText("Send message"));
    await screen.findByRole("button", { name: "Not now" });
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/chat/confirm/"));
      expect(call?.[0]).toContain("/chat/confirm/paused-1");
      expect(JSON.parse(call?.[1]?.body ?? "{}")).toEqual({ approve: false });
    });
  });

  it("takes the card away once it has been answered", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/chat/confirm/")
          ? streamOf([
              { type: "delta", text: " Created." },
              { type: "done", message: answer },
            ])
          : streamOf(confirmFrames),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    await renderChat();
    listMessages.mockReturnValue(new Promise(() => {}));

    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "every monday",
    );
    await userEvent.click(screen.getByLabelText("Send message"));
    await screen.findByRole("button", { name: "Approve" });
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    });
  });
});

describe("the browser beside the conversation", () => {
  const running = {
    tasks: [
      {
        id: "task-1",
        task: "find the invoice",
        status: "running",
        output: null,
        error: null,
        retryOf: null,
        createdAt: 0,
        finishedAt: null,
        apiVersion: "v4",
        stopReason: null,
        browserSessionId: "bs-1",
        signInHost: null,
        carriedSavedLogin: false,
      },
    ],
    session: { id: "bs-1", liveState: "agent", humanSince: null, browserReady: true },
    events: [],
    delivered: false,
  };

  /**
   * Task 3.1 (ruling R42): the header control is always there for the person
   * who owns the conversation, so a browser can be opened to sign in ahead of
   * time. The panel does not open by itself, and the control alone rents
   * nothing — only the panel's Open browser does.
   */
  it("is offered to its owner in a conversation with no browser, and the control rents nothing", async () => {
    await renderChat();

    await waitFor(() => expect(browserTasks).toHaveBeenCalledWith("session-1"));
    expect(screen.queryByRole("heading", { name: "Browser" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Show the browser" }));
    expect(await screen.findByRole("heading", { name: "Browser" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Open browser" })).toBeInTheDocument();
    expect(takeoverOpen).not.toHaveBeenCalled();
  });

  it("is not offered to somebody who does not own the conversation", async () => {
    session.ownerId = "someone-else";
    try {
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ChatTab />
        </QueryClientProvider>,
      );
      await screen.findByPlaceholderText(composerPlaceholder(agent.name));
      await waitFor(() => expect(browserTasks).toHaveBeenCalledWith("session-1"));
      expect(screen.queryByRole("button", { name: "Show the browser" })).toBeNull();
    } finally {
      session.ownerId = "user-1";
    }
  });

  it("opens beside the chat while the agent is browsing", async () => {
    browserTasks.mockResolvedValue(running);
    await renderChat();

    expect(await screen.findByRole("heading", { name: "Browser" })).toBeInTheDocument();
    expect(await screen.findByTitle("The agent's browser")).toBeInTheDocument();
  });

  /**
   * Found in the end-to-end run: the poll is off while nothing is happening,
   * so a conversation opened with no browser never asked again, and the panel
   * stayed shut through a whole run the agent started mid-turn. A `browse`
   * step that settles is the moment a run exists, so the screen asks then.
   */
  it("opens by itself when the agent starts browsing in this turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            { type: "step", index: 0, tool: "browse", status: "running", label: "browse" },
            { type: "step", index: 0, tool: "browse", status: "ok", label: "browse" },
            { type: "delta", text: "A browser is on it." },
            { type: "done", message: answer },
          ]),
        ),
      ),
    );
    await renderChat();
    await waitFor(() => expect(browserTasks).toHaveBeenCalledWith("session-1"));
    expect(screen.queryByRole("heading", { name: "Browser" })).toBeNull();

    browserTasks.mockResolvedValue(running);
    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "read the page",
    );
    await userEvent.click(screen.getByLabelText("Send message"));

    expect(await screen.findByRole("heading", { name: "Browser" })).toBeInTheDocument();
    expect(await screen.findByTitle("The agent's browser")).toBeInTheDocument();
  });

  /**
   * Found in the end-to-end run: the panel shut itself the moment the run
   * finished, taking the page the agent had just read with it. The browser
   * is still there, idle, until it is stopped; once the panel has opened by
   * itself it stays until the person closes it.
   */
  it("stays open when the run finishes, until the person closes it", async () => {
    browserTasks.mockResolvedValue(running);
    const { client } = await renderChat();
    expect(await screen.findByRole("heading", { name: "Browser" })).toBeInTheDocument();

    const finished = {
      ...running,
      tasks: [{ ...running.tasks[0], status: "finished", output: "the title", finishedAt: 1 }],
      session: { ...running.session, liveState: "none" },
    };
    browserTasks.mockResolvedValue(finished);
    await act(async () => {
      client.setQueryData(["browser-tasks", "session-1"], finished);
    });

    expect(await screen.findByText("The agent is not using the browser")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Browser" })).toBeInTheDocument();
  });

  it("comes back from the header control after it was closed", async () => {
    browserTasks.mockResolvedValue(running);
    await renderChat();

    // A run is going, so close only hides it — stop would not cancel the run.
    await userEvent.click(await screen.findByRole("button", { name: "Close the browser" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Browser" })).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Show the browser" }));
    expect(await screen.findByRole("heading", { name: "Browser" })).toBeInTheDocument();
  });

  it("waits for the header control on a narrow screen, then opens as a sheet", async () => {
    onAPhone = true;
    browserTasks.mockResolvedValue(running);
    await renderChat();

    const control = await screen.findByRole("button", { name: "Show the browser" });
    expect(screen.queryByRole("dialog", { name: "Browser" })).toBeNull();

    await userEvent.click(control);
    expect(await screen.findByRole("dialog", { name: "Browser" })).toBeInTheDocument();
  });
  /**
   * Opening the panel used to swap `return chatPane` for a split around it,
   * which remounted the chat column: the scroll listener stayed on the
   * detached node, so "jump to the latest" never appeared again, and a draft
   * in an edit box was lost. The column is now the same node throughout.
   */
  it("keeps the chat column, and its scrolling, when the panel opens", async () => {
    const { container, client } = await renderChat();
    const column = container.querySelector("section");
    expect(column).not.toBeNull();

    browserTasks.mockResolvedValue(running);
    await act(async () => {
      client.setQueryData(["browser-tasks", "session-1"], running);
    });
    expect(await screen.findByRole("heading", { name: "Browser" })).toBeInTheDocument();
    expect(container.querySelector("section")).toBe(column);

    act(() => place(scroller(container), { scrollTop: 0, scrollHeight: 4000, clientHeight: 600 }));
    expect(screen.getByLabelText("Jump to the latest message")).toBeInTheDocument();
  });

  /**
   * On a phone the sheet never opens by itself and the prompt is inside it,
   * so a login wall would otherwise be invisible: the header control carries
   * the filled square — "this one is yours" — while a sign-in waits.
   */
  it("marks the header control on a narrow screen while a sign-in waits", async () => {
    onAPhone = true;
    browserTasks.mockResolvedValue({
      ...running,
      tasks: [{ ...running.tasks[0], status: "failed", stopReason: "login_required" }],
      session: { ...running.session, liveState: "none" },
    });
    await renderChat();

    const control = await screen.findByRole("button", {
      name: "Show the browser: a site needs you to sign in",
    });
    expect(control.querySelector(".bg-brand")).not.toBeNull();
  });

  it("does not mark it when nothing is waiting on the person", async () => {
    onAPhone = true;
    browserTasks.mockResolvedValue(running);
    await renderChat();

    const control = await screen.findByRole("button", { name: "Show the browser" });
    expect(control.querySelector(".bg-brand")).toBeNull();
  });

  /** Ruling R18: a drained v2 task keeps its old card, in the transcript. */
  it("still offers a v2 task's sign-in in the transcript", async () => {
    browserTasks.mockResolvedValue({
      tasks: [
        {
          ...running.tasks[0],
          status: "failed",
          output: "could not sign in",
          apiVersion: "v2",
          browserSessionId: null,
        },
      ],
      session: null,
      events: [],
      delivered: false,
    });
    await renderChat();

    expect(await screen.findByRole("button", { name: /sign in myself/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Browser" })).toBeNull();
  });
});

// The whole screen and then a Radix menu on top of it: slow on a loaded
// laptop, not stuck, so the same leash as the heaviest case above.
describe("the dial beside the question", { timeout: 20_000 }, () => {
  // Put back before each case rather than only in a `finally`, which a timed
  // out test never reaches — and a dial left turned would fail every test
  // after it for a reason none of them is about.
  beforeEach(() => {
    Object.assign(session, { model: null, reasoningEffort: null, webSearch: null, mode: null });
  });

  const opusThinks = {
    ...meDefault,
    modelSpecs: {
      "gpt-4.1": { temperature: true, reasoning: false },
      "claude-opus-5": { temperature: false, reasoning: true },
    },
  };

  it("shows what this conversation is answered with, and says the same under the composer", async () => {
    meReply = opusThinks;
    Object.assign(session, { model: "claude-opus-5", reasoningEffort: "high" });
    try {
      await renderChat();

      // By its tier's word, on the chip and under the composer alike.
      expect(await screen.findByLabelText("Model: Best")).toBeInTheDocument();
      expect(await screen.findByLabelText("Thinking: Extended")).toBeInTheDocument();
      expect(screen.getByLabelText("Web search: Off")).toBeInTheDocument();
      expect(screen.getByText(/GTM Agent · Best · Extended ·/)).toBeInTheDocument();
    } finally {
      Object.assign(session, { model: null, reasoningEffort: null });
    }
  });

  it("asks the server to change the conversation, not the agent", async () => {
    tuneSession.mockResolvedValue({ ...session, model: "claude-opus-5" });
    await renderChat();

    fireEvent.keyDown(screen.getByLabelText("Model: gpt-4.1"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Best/ }));

    await waitFor(() =>
      expect(tuneSession).toHaveBeenCalledWith("session-1", { model: "claude-opus-5" }),
    );
  });

  it("leaves a conversation somebody else started as a reading of it", async () => {
    session.ownerId = "someone-else";
    try {
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ChatTab />
        </QueryClientProvider>,
      );
      const model = await screen.findByLabelText("Model: gpt-4.1");
      expect(model).toHaveAttribute("aria-disabled", "true");
      fireEvent.keyDown(model, { key: "Enter" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(tuneSession).not.toHaveBeenCalled();
    } finally {
      session.ownerId = "user-1";
    }
  });
});

describe("a document written from the conversation", () => {
  /** A job created a second before `answer`, so its card sits under that reply. */
  const job = (over: Record<string, unknown> = {}) => ({
    id: "job-1",
    agentId: agent.id,
    sessionId: session.id,
    bundleId: "bundle-1",
    origin: "tool",
    instruction: "Write up the pricing.",
    title: "Pricing review",
    status: "writing",
    written: 1,
    total: 2,
    documentId: null,
    error: null,
    createdAt: "2026-09-17T10:00:04Z",
    updatedAt: "2026-09-17T10:00:04Z",
    finishedAt: null,
    sections: [
      { index: 0, heading: "Where we are", body: "Forty dollars a seat.", done: true },
      { index: 1, heading: "What to change", body: "", done: false },
    ],
    ...over,
  });

  it("puts the document's card under the reply that started it", async () => {
    listMessages.mockResolvedValue([question, answer]);
    documentJobs.mockResolvedValue([job()]);

    await renderChat();

    const card = await screen.findByRole("button", { name: "Open Pricing review" });
    expect(card).toHaveTextContent("Writing — 1 of 2 sections");
  });

  it("opens it beside the conversation, filling in section by section", async () => {
    listMessages.mockResolvedValue([question, answer]);
    documentJobs.mockResolvedValue([job()]);

    await renderChat();
    await userEvent.click(await screen.findByRole("button", { name: "Open Pricing review" }));

    expect(await screen.findByRole("heading", { name: "Pricing review" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Where we are" })).toBeInTheDocument();
    expect(screen.getByText("Being written…")).toBeInTheDocument();
  });

  it("can be stopped from the panel while it is being written", async () => {
    listMessages.mockResolvedValue([question, answer]);
    documentJobs.mockResolvedValue([job()]);

    await renderChat();
    await userEvent.click(await screen.findByRole("button", { name: "Open Pricing review" }));
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));

    expect(stopDocument).toHaveBeenCalledWith("job-1");
  });

  it("offers the finished document as Markdown, Word and PDF", async () => {
    listMessages.mockResolvedValue([question, answer]);
    documentJobs.mockResolvedValue([
      job({ status: "ready", written: 2, documentId: "doc-9", sections: [] }),
    ]);

    await renderChat();
    await userEvent.click(await screen.findByRole("button", { name: "Open Pricing review" }));

    for (const name of ["Markdown", "Word", "PDF"]) {
      expect(await screen.findByRole("button", { name })).toBeInTheDocument();
    }
  });
});

/**
 * A cold load of a thread's own link. The sessions query answers `[]` until
 * its first response, which the page used to read as "this agent has no
 * conversations": it started a new one and replaced the URL, so the person
 * who opened the link met an empty "New thread" and the sidebar kept it.
 */
describe("opening a thread's link before the sessions have loaded", () => {
  afterEach(() => {
    store.sessions = [session];
    store.sessionsLoaded = true;
  });

  it("waits for the sessions rather than starting a new conversation", async () => {
    store.sessions = [];
    store.sessionsLoaded = false;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <ChatTab />
      </QueryClientProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(store.startSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("starts one once the sessions have answered that there are none", async () => {
    store.sessions = [];
    store.sessionsLoaded = true;
    store.startSession.mockResolvedValue({ id: "session-new" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <ChatTab />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(store.startSession).toHaveBeenCalledWith("agent-1"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ search: { s: "session-new" }, replace: true }),
      ),
    );
  });
});

/**
 * The conversation the first run opens.
 *
 * The welcome screen leaves a flag under `chat-kickoff:<id>` and lands here on
 * an empty conversation. The assistant speaks first — one `/chat/stream` call
 * with `kickoff: true`, the flag spent as it is read — and the Connect card
 * for the first tool the person named sits under what it said, drawn by this
 * screen rather than by the model.
 */
describe("the conversation the first run opens", () => {
  const opening = {
    id: "msg-k",
    role: "assistant" as const,
    content: "Hi Ada. This is Desk.",
    createdAt: Date.parse("2026-09-17T10:00:00Z"),
  };

  beforeEach(() => {
    meReply = {
      ...meDefault,
      onboarding: {
        completed: true,
        lastStep: "done",
        agentId: "agent-1",
        sessionId: "session-1",
        answers: { tools: ["gmail", "notion"], mode: "solo" },
      },
    };
    listMessages.mockResolvedValue([]);
    sessionStorage.clear();
    localStorage.clear();
  });

  it("opens once, spends the flag, and puts the Connect card under the opening", async () => {
    sessionStorage.setItem("chat-kickoff:session-1", "1");
    // Empty when the screen opens — that is what fires the opening — and the
    // opening on every read after it, as the server would answer once the
    // reply is written.
    listMessages.mockResolvedValueOnce([]).mockResolvedValue([opening]);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        streamOf([
          { type: "delta", text: "Hi Ada. This is Desk." },
          { type: "done", message: opening },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await renderChat();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(/\/chat\/stream$/);
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: "session-1", kickoff: true });
    expect(sessionStorage.getItem("chat-kickoff:session-1")).toBeNull();

    expect(await screen.findByText("Hi Ada. This is Desk.")).toBeInTheDocument();
    expect(await screen.findByText("Connect Gmail")).toBeInTheDocument();
    // Still one call: the reply landing re-rendered the screen with the
    // flag already spent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not open again on a reload, and keeps the card under the opening", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    listMessages.mockResolvedValue([opening]);

    await renderChat();

    expect(await screen.findByText("Connect Gmail")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows no card in any other conversation, and none once it is put down", async () => {
    listMessages.mockResolvedValue([opening]);
    localStorage.setItem("covan:kickoff-card:session-1", "1");
    await renderChat();
    await screen.findByText("Hi Ada. This is Desk.");
    expect(screen.queryByText("Connect Gmail")).not.toBeInTheDocument();
  });
});

describe("what a shared thread can read", () => {
  // The server answers a shared thread from shared folders only, and the
  // footer used to count every document the agent had anyway. A tester read
  // "grounded in 1 document" under an answer that could not read that one
  // document, and concluded the product was broken.
  it("counts only the shared folders' documents, and says why", async () => {
    session.visibility = "shared";
    store.bundles = [
      { id: "b-mine", name: "My notes", shared: false, mine: true },
      { id: "b-team", name: "Handbook" },
    ];
    agent.documents = [
      { id: "d1", name: "notes.md", indexed: true, createdAt: Date.now(), bundleId: "b-mine" },
      { id: "d2", name: "handbook.md", indexed: true, createdAt: Date.now(), bundleId: "b-team" },
    ];
    listMessages.mockResolvedValue([]);
    try {
      await renderChat();

      expect(screen.getByText(/grounded in 1 team document$/)).toBeInTheDocument();
      // Once in the empty screen, once under the composer.
      expect(screen.getAllByText(/can't read your private folders \(1 document\)/)).toHaveLength(2);
      // And the first starter names a file the thread can actually cite.
      expect(
        screen.getByRole("button", { name: "What does handbook.md say?" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "What does notes.md say?" })).toBeNull();
    } finally {
      session.visibility = "private";
      store.bundles = [];
      agent.documents = [];
    }
  });

  it("counts everything, and says nothing, in a private thread", async () => {
    store.bundles = [{ id: "b-mine", name: "My notes", shared: false, mine: true }];
    agent.documents = [
      { id: "d1", name: "notes.md", indexed: true, createdAt: Date.now(), bundleId: "b-mine" },
    ];
    listMessages.mockResolvedValue([]);
    try {
      await renderChat();

      expect(screen.getByText(/grounded in 1 team document$/)).toBeInTheDocument();
      expect(screen.queryByText(/can't read your private folders/)).toBeNull();
    } finally {
      store.bundles = [];
      agent.documents = [];
    }
  });
});

describe("what the chips offer next", () => {
  it("does not offer the question that was just asked", async () => {
    // The drafter is told not to, and a tester saw it happen anyway: the chip
    // under the answer was the question above it.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            { type: "delta", text: "Forty dollars a seat." },
            { type: "done", message: answer },
            { type: "suggestions", questions: ["And per seat?", "And for annual billing?"] },
          ]),
        ),
      ),
    );
    await renderChat();
    const asked = { ...question, id: "msg-1b", content: "and per seat?" };
    listMessages.mockResolvedValue([question, asked, answer]);

    await userEvent.type(
      screen.getByPlaceholderText(composerPlaceholder("GTM Agent")),
      "and per seat?",
    );
    await userEvent.click(screen.getByLabelText("Send message"));

    expect(
      await screen.findByRole("button", { name: "And for annual billing?" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "And per seat?" })).toBeNull();
  });
});

describe("who can read this thread", () => {
  // It used to be said three times — an icon in the header, a sentence under
  // the greeting, a clause under the composer — and a tester who read
  // "private" in one and "shared" in another could not tell which to believe.
  it("is said once, in words, on the header control", async () => {
    listMessages.mockResolvedValue([]);
    await renderChat();

    const control = screen.getByRole("button", { name: /Private to you/ });
    expect(control).toHaveTextContent("Private to you");
    expect(control).toHaveAttribute("aria-pressed", "false");
    // Nowhere else on the screen.
    expect(screen.getAllByText(/private to you/i)).toHaveLength(1);
    expect(screen.queryByText(/shared with your workspace/i)).toBeNull();
    expect(screen.getByText(/grounded in 0 team documents$/)).toBeInTheDocument();
  });

  it("says a brainstorm is the team's from the start, where the brainstorm opens", async () => {
    session.kind = "brainstorm";
    session.visibility = "shared";
    listMessages.mockResolvedValue([]);
    try {
      await renderChat();

      expect(
        screen.getByText(/Brainstorms are shared with your team from the start/),
      ).toBeInTheDocument();
      const control = screen.getByRole("button", { name: /Shared with your workspace/ });
      expect(control).toHaveTextContent("Shared with workspace");
      expect(control).toHaveAttribute("aria-pressed", "true");
    } finally {
      session.kind = "chat";
      session.visibility = "private";
    }
  });
});

describe("the first thing to do in an empty conversation", () => {
  // The screen used to offer "Summarize what you know" to an agent that knew
  // nothing, and the first answer a new workspace saw was "I couldn't find
  // that". A tester said the first minute is where a product earns its "oh,
  // nice", and spent it on that.
  it("asks an editor for a document instead of offering starters about nothing", async () => {
    agent.myAccess = "edit";
    listMessages.mockResolvedValue([]);
    try {
      await renderChat();

      expect(screen.getByRole("button", { name: "Upload a document" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open the Knowledge tab" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Summarize what you know" })).toBeNull();
      expect(screen.queryByRole("button", { name: "What can you help me with?" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Open the Knowledge tab" }));
      expect(navigate).toHaveBeenCalledWith({
        to: "/agents/$agentId/knowledge",
        params: { agentId: "agent-1" },
      });
    } finally {
      agent.myAccess = "use";
    }
  });

  it("tells somebody who cannot upload that nothing has been added, and offers no button", async () => {
    listMessages.mockResolvedValue([]);
    await renderChat();

    expect(screen.getByText("Nobody has added documents to GTM Agent yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload a document" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Summarize what you know" })).toBeNull();
  });

  it("goes back to starters, named after a real file, once something is indexed", async () => {
    agent.documents = [{ id: "d1", name: "handbook.md", indexed: true, createdAt: Date.now() }];
    listMessages.mockResolvedValue([]);
    try {
      await renderChat();

      expect(
        screen.getByRole("button", { name: "What does handbook.md say?" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Upload your first document")).toBeNull();
    } finally {
      agent.documents = [];
    }
  });

  it("sends a shared thread to the Knowledge tab rather than the picker", async () => {
    agent.myAccess = "edit";
    session.visibility = "shared";
    listMessages.mockResolvedValue([]);
    try {
      await renderChat();

      expect(
        screen.getByRole("button", { name: "Add documents on the Knowledge tab" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Upload a document" })).toBeNull();
    } finally {
      agent.myAccess = "use";
      session.visibility = "private";
    }
  });
});

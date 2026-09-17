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
  documents: [] as { id: string; name: string; indexed: boolean; createdAt: number }[],
};

const session = {
  id: "session-1",
  agentId: "agent-1",
  ownerId: "user-1",
  visibility: "private" as const,
  kind: "chat" as const,
  title: "Pricing",
  updatedAt: Date.parse("2026-09-17T10:00:00Z"),
};

const store = {
  agents: [agent],
  sessions: [session],
  startSession: vi.fn(),
  canWrite: true,
};
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

const listMessages = vi.fn();
const createMessage = vi.fn();
const showVersion = vi.fn();
vi.mock("@/lib/api-client", () => ({
  ApiError: class ApiError extends Error {
    status = 500;
  },
  getAccessToken: () => Promise.resolve("token"),
  api: {
    me: () => Promise.resolve({ user: { id: "user-1" }, models: ["gpt-4.1", "claude-opus-5"] }),
    sessions: { messages: listMessages, setVisibility: vi.fn() },
    messages: {
      create: createMessage,
      update: vi.fn(),
      deleteAfter: vi.fn(),
      show: showVersion,
    },
    brainstorm: { suggest: vi.fn() },
    ideas: { create: vi.fn() },
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

vi.mock("@/lib/quota", () => ({ useQuota: () => null, quotaSentence: () => "" }));
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
    receipt: null,
    dialogOpen: false,
    setDialogOpen: vi.fn(),
    write: vi.fn(),
    dismiss: vi.fn(),
    download: vi.fn(),
  }),
}));

vi.mock("@/components/chat-attach", () => ({ ChatAttach: () => null, ChatReceipts: () => null }));
vi.mock("@/components/chat-report", () => ({
  ChatReport: () => null,
  ChatReportReceipt: () => null,
}));
vi.mock("@/components/chat-mic", () => ({ ChatMic: () => null }));
vi.mock("@/components/feedback-dialog", () => ({ FeedbackDialog: () => null }));
vi.mock("@/components/idea-board", () => ({ IdeaBoard: () => null }));
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
  // Waits on the Share button rather than the composer, which renders before
  // anything has loaded. Share needs `isOwner`, which needs `/me` — so by the
  // time it is on screen both queries have settled and the shortcuts that turn
  // on ownership behave the way they will in a browser.
  await screen.findByPlaceholderText(`Message ${agent.name}`);
  await screen.findByText("Share");
  return { ...view, client };
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
  onAPhone = false;
  stubMatchMedia();
  listMessages.mockResolvedValue([question]);
  createMessage.mockResolvedValue(question);
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

    await userEvent.type(screen.getByPlaceholderText("Message GTM Agent"), "and per seat?");
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

    await userEvent.type(screen.getByPlaceholderText("Message GTM Agent"), "and per seat?");
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
  const composer = () => screen.getByPlaceholderText(`Message ${agent.name}`);

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

describe("the keys beside Enter", () => {
  const composer = () => screen.getByPlaceholderText(`Message ${agent.name}`);

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
    await userEvent.type(screen.getByPlaceholderText(`Message ${agent.name}`), "how much?{Enter}");

    await waitFor(() => expect(container.querySelector("strong")).toBeInTheDocument());
    expect(container.querySelector("strong")).toHaveTextContent("Forty");
    expect(screen.getByText("Pricing")).toBeInTheDocument();
    // And nothing on screen still shows the marks themselves.
    expect(screen.queryByText(/\*\*Forty\*\*/)).not.toBeInTheDocument();
  });

  it("carries the caret while the reply is arriving, and drops it after", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(openStream())),
    );
    const { container } = await renderChat();
    await userEvent.type(screen.getByPlaceholderText(`Message ${agent.name}`), "how much?{Enter}");

    await waitFor(() => expect(container.querySelector(".stream-live")).toBeInTheDocument());

    fireEvent.keyDown(screen.getByPlaceholderText(`Message ${agent.name}`), { key: "Escape" });

    // Stopped: the text stays until the server's copy replaces it, but it is
    // no longer arriving, so it no longer claims to be.
    await waitFor(() => expect(container.querySelector(".stream-live")).not.toBeInTheDocument());
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

    await userEvent.type(screen.getByPlaceholderText(`Message ${agent.name}`), "how much?{Enter}");

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

    await userEvent.type(screen.getByPlaceholderText(`Message ${agent.name}`), "how much?{Enter}");

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
    await userEvent.type(screen.getByPlaceholderText(`Message ${agent.name}`), "how much?{Enter}");

    await waitFor(() => expect(listMessages).toHaveBeenCalledWith("session-1", { limit: 200 }));
  });
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

    await userEvent.type(screen.getByPlaceholderText(`Message ${agent.name}`), "how much?{Enter}");

    expect(await screen.findByText("This answer hit its length limit.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("asks the server to finish the reply rather than answer again", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(truncatedReply()));
    vi.stubGlobal("fetch", fetchMock);
    await renderChat();
    listMessages.mockResolvedValue([question, cutOff]);
    await userEvent.type(screen.getByPlaceholderText(`Message ${agent.name}`), "how much?{Enter}");
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
    await userEvent.type(screen.getByPlaceholderText(`Message ${agent.name}`), "how much?{Enter}");
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
    expect(container.querySelectorAll(`[class*="pl-9"]`).length).toBe(1);
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });
});

describe("the pause before an answer", () => {
  it("shows what the model is working through, folded away", async () => {
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
    await userEvent.type(screen.getByPlaceholderText(`Message ${agent.name}`), "how much?{Enter}");

    const block = await waitFor(() => {
      const el = container.querySelector("details");
      expect(el).toBeInTheDocument();
      return el as HTMLDetailsElement;
    });
    expect(block.open).toBe(false);
    expect(block).toHaveTextContent("The handbook says forty — check the volume rule.");
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
    await userEvent.type(screen.getByPlaceholderText(`Message ${agent.name}`), "how much?{Enter}");

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

    const box = screen.getByPlaceholderText("Search");
    await userEvent.type(box, "roll");

    await waitFor(() => {
      expect(screen.getByText(/Twenty days, plus up to five can roll over/)).toBeInTheDocument();
      expect(screen.queryByText("What do we charge?")).not.toBeInTheDocument();
    });
    expect(screen.getByText("1 of 3 messages")).toBeInTheDocument();
  });

  it("says how many matched, or that nothing did", async () => {
    listMessages.mockResolvedValue([question, answer]);
    await renderChat();

    await userEvent.type(screen.getByPlaceholderText("Search"), "vacation");

    await waitFor(() => expect(screen.getByText("No matches")).toBeInTheDocument());
  });

  it("clears the search on Escape", async () => {
    listMessages.mockResolvedValue([older, question, answer]);
    await renderChat();

    const box = screen.getByPlaceholderText("Search");
    await userEvent.type(box, "roll");
    await waitFor(() => expect(screen.getByText("1 of 3 messages")).toBeInTheDocument());

    fireEvent.keyDown(box, { key: "Escape" });

    await waitFor(() => expect(screen.queryByText("1 of 3 messages")).not.toBeInTheDocument());
    expect(screen.getByText(/What do we charge/)).toBeInTheDocument();
  });
});

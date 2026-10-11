import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrowserTask, ConversationBrowser, LiveState } from "@/lib/api-client";
import { ApiError } from "@/lib/api-error";
import { BrowserPanel } from "./browser-panel";

/**
 * The browser beside the conversation.
 *
 * Four things here are not taste. The frame is inert while the agent drives,
 * because a person's click landing in the middle of the agent's typing is the
 * failure Review focus 2 is about. The live URL is a credential and lives in
 * component state only. Polling costs a provider call per tick, so it runs
 * only while something is happening. And the amber hairline is the one amber
 * element over 44px DESIGN.md allows, so it is there only while it means
 * something.
 */

const SECRET = "https://live.browser-use.com/secret-address-for-the-panel";

const browserTasks = vi.fn();
const live = vi.fn();
const takeOver = vi.fn();
const handBack = vi.fn();
const stop = vi.fn();
const removeWaiting = vi.fn();
const save = vi.fn();
const takeoverCurrent = vi.fn();
const takeoverOpen = vi.fn();
const takeoverClose = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    sessions: { browserTasks: (...a: unknown[]) => browserTasks(...a) },
    takeovers: {
      current: (...a: unknown[]) => takeoverCurrent(...a),
      open: (...a: unknown[]) => takeoverOpen(...a),
      close: (...a: unknown[]) => takeoverClose(...a),
    },
    browser: {
      live: (...a: unknown[]) => live(...a),
      takeOver: (...a: unknown[]) => takeOver(...a),
      handBack: (...a: unknown[]) => handBack(...a),
      stop: (...a: unknown[]) => stop(...a),
      removeWaiting: (...a: unknown[]) => removeWaiting(...a),
      credentials: {
        save: (...a: unknown[]) => save(...a),
        list: () => Promise.resolve({ logins: [] }),
      },
    },
  },
}));

function task(over: Partial<BrowserTask> = {}): BrowserTask {
  return {
    id: "task-1",
    task: "find the invoice on the supplier portal",
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
    savedLogin: null,
    ...over,
  };
}

function snapshot(
  liveState: LiveState,
  tasks: BrowserTask[],
  over: Partial<ConversationBrowser> = {},
): ConversationBrowser {
  return {
    tasks,
    session: { id: "bs-1", liveState, humanSince: null, browserReady: true },
    events: [],
    delivered: false,
    ...over,
  };
}

const agentDriving = () => snapshot("agent", [task()]);
const personDriving = () =>
  snapshot("human", [task({ status: "stopped", stopReason: "handed_to_person" })]);
const idle = () => snapshot("none", [task({ status: "finished", output: "found it" })]);

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onHide = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <BrowserPanel sessionId="s-1" agentId="agent-1" canShare onHide={onHide} />
    </QueryClientProvider>,
  );
  return { client, onHide, ...view };
}

/** The wrapper the iframe sits in: the thing that is or is not inert. */
async function frameWrapper(): Promise<HTMLElement> {
  await screen.findByTitle("The agent's browser");
  return screen.getByTestId("browser-frame");
}

beforeEach(() => {
  browserTasks.mockReset();
  live.mockReset().mockResolvedValue({ liveUrl: SECRET, liveState: "agent" });
  // Each control moves the server's row the way the real route does, so the
  // poll that follows agrees with it rather than snapping the panel back.
  takeOver.mockReset().mockImplementation(async () => {
    browserTasks.mockResolvedValue(personDriving());
    return { liveState: "human", humanSince: 1_000 };
  });
  handBack.mockReset().mockImplementation(async () => {
    browserTasks.mockResolvedValue(
      snapshot("agent", [
        task({ id: "task-2", status: "queued", retryOf: "task-1" }),
        task({ status: "stopped", stopReason: "handed_to_person" }),
      ]),
    );
    return { browserTaskId: "task-2" };
  });
  stop.mockReset().mockResolvedValue(undefined);
  removeWaiting.mockReset().mockResolvedValue(undefined);
  // Nobody has a browser of their own open, which is the ordinary case.
  takeoverCurrent.mockReset().mockResolvedValue({ takeover: null });
  takeoverOpen.mockReset().mockResolvedValue({
    id: "to-1",
    liveUrl: SECRET,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  takeoverClose.mockReset().mockResolvedValue({
    retriedTaskId: null,
    cookieDomains: ["linkedin.com"],
    message: "the browser is closed and your sign-ins are saved to your browser profile.",
  });
  save.mockReset().mockResolvedValue({
    credential: {
      id: "cred-1",
      scope: "owner",
      siteHost: "linkedin.com",
      label: "linkedin.com — personal",
      replaced: false,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

describe("who can touch the frame", () => {
  it("is inert while the agent drives", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    renderPanel();

    const wrapper = await frameWrapper();
    expect(wrapper).toHaveAttribute("inert");
    expect(wrapper).toHaveAttribute("tabindex", "-1");
    expect(wrapper).toHaveClass("pointer-events-none");
  });

  it("loses all three when the person is driving", async () => {
    browserTasks.mockResolvedValue(personDriving());
    renderPanel();

    const wrapper = await frameWrapper();
    expect(wrapper).not.toHaveAttribute("inert");
    expect(wrapper).not.toHaveAttribute("tabindex");
    expect(wrapper).not.toHaveClass("pointer-events-none");
  });

  it("embeds the live view with autoplay and no sandbox", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    renderPanel();

    const frame = await screen.findByTitle("The agent's browser");
    expect(frame).toHaveAttribute("src", SECRET);
    expect(frame).toHaveAttribute("allow", "autoplay");
    expect(frame).not.toHaveAttribute("sandbox");
  });

  it("says the browser is starting while there is none to show", async () => {
    live.mockRejectedValue(new ApiError(409, "no browser is open beside this conversation"));
    browserTasks.mockResolvedValue(
      snapshot("agent", [task({ status: "queued" })], {
        session: { id: "bs-1", liveState: "agent", humanSince: null, browserReady: false },
      }),
    );
    renderPanel();

    expect(await screen.findAllByText("Starting the browser…")).not.toHaveLength(0);
    expect(screen.queryByTitle("The agent's browser")).toBeNull();
  });
});

describe("polling", () => {
  it("asks every three seconds while the agent drives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    browserTasks.mockResolvedValue(agentDriving());
    renderPanel();
    await waitFor(() => expect(browserTasks).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(3_100));
    expect(browserTasks).toHaveBeenCalledTimes(2);
  });

  it("keeps asking while the person drives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    browserTasks.mockResolvedValue(personDriving());
    renderPanel();
    await waitFor(() => expect(browserTasks).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(3_100));
    expect(browserTasks).toHaveBeenCalledTimes(2);
  });

  /**
   * Ruling R21: the poll is also the heartbeat that keeps a person's browser
   * from being swept while they are still signing in — and "Open in new
   * window" is exactly the path that puts the Covan tab in the background.
   * A backgrounded tab stops polling by default, so in human mode it must not.
   */
  it("keeps asking from a background tab while the person drives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    focusManager.setFocused(false);
    try {
      browserTasks.mockResolvedValue(personDriving());
      renderPanel();
      await waitFor(() => expect(browserTasks).toHaveBeenCalledTimes(1));

      await act(() => vi.advanceTimersByTimeAsync(3_100));
      expect(browserTasks).toHaveBeenCalledTimes(2);
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  it("does not ask from a background tab while the agent drives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    focusManager.setFocused(false);
    try {
      browserTasks.mockResolvedValue(agentDriving());
      renderPanel();
      await waitFor(() => expect(browserTasks).toHaveBeenCalledTimes(1));

      await act(() => vi.advanceTimersByTimeAsync(3_100));
      expect(browserTasks).toHaveBeenCalledTimes(1);
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  /** Every tick is a provider call; a browser nobody is using is not worth one. */
  it("stops when nothing is running and nobody holds the browser", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    browserTasks.mockResolvedValue(idle());
    renderPanel();
    await waitFor(() => expect(browserTasks).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(browserTasks).toHaveBeenCalledTimes(1);
  });

  /**
   * A v2 task drained from before 0078 is the cron's: the live endpoint polls
   * v4 runs only, so asking every three seconds about one buys nothing.
   */
  it("does not poll for a v2 task that is still running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    browserTasks.mockResolvedValue({
      tasks: [task({ apiVersion: "v2", browserSessionId: null })],
      session: null,
      events: [],
      delivered: false,
    });
    renderPanel();
    await waitFor(() => expect(browserTasks).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(browserTasks).toHaveBeenCalledTimes(1);
  });

  it("refreshes the conversation when a poll delivered the answer", async () => {
    browserTasks.mockResolvedValue({ ...idle(), delivered: true });
    const { client } = renderPanel();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["messages", "s-1"] }));
  });
});

describe("the live URL", () => {
  /**
   * *"Treat the URL as a credential."* A query cache is a thing that persists,
   * gets devtools-inspected and gets serialised; storage outlives the tab. The
   * real cache is read here, keys AND data, after the URL has been minted twice.
   */
  it("is in no query key, no cached answer and no storage", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    const { client } = renderPanel();

    expect(await screen.findByTitle("The agent's browser")).toHaveAttribute("src", SECRET);
    await userEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(live).toHaveBeenCalledTimes(2));

    const queries = client
      .getQueryCache()
      .getAll()
      .map((q) => ({ key: q.queryKey, data: q.state.data, error: String(q.state.error) }));
    const mutations = client
      .getMutationCache()
      .getAll()
      .map((m) => ({ key: m.options.mutationKey, data: m.state.data, vars: m.state.variables }));
    expect(queries.length).toBeGreaterThan(0);
    expect(JSON.stringify(queries)).not.toContain("secret-address");
    expect(JSON.stringify(mutations)).not.toContain("secret-address");

    const stored = [localStorage, sessionStorage].flatMap((s) =>
      Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i) ?? "")}`),
    );
    expect(stored.join("\n")).not.toContain("secret-address");
  });

  it("is never rendered as text", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    const { container } = renderPanel();

    await screen.findByTitle("The agent's browser");
    expect(container.textContent ?? "").not.toContain("secret-address");
  });

  /**
   * Final-review I3. The first mint usually lands before the provider has a
   * browser (409), and `browserReady` may already be true from the previous
   * run — so a run that is going with no view on screen asks again on each
   * poll rather than leaving the frame blank for the whole run.
   */
  it("is asked for again on each poll while a run is going and there is no view yet", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    live
      .mockRejectedValueOnce(new ApiError(409, "no browser is open beside this conversation"))
      .mockRejectedValueOnce(new ApiError(409, "no browser is open beside this conversation"))
      .mockResolvedValue({ liveUrl: SECRET, liveState: "agent" });
    browserTasks.mockResolvedValue(agentDriving());
    renderPanel();
    await waitFor(() => expect(live).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(3_100));
    await waitFor(() => expect(live).toHaveBeenCalledTimes(2));
    await act(() => vi.advanceTimersByTimeAsync(3_100));

    expect(await screen.findByTitle("The agent's browser")).toHaveAttribute("src", SECRET);
    // Once there is a view, the polls stop asking.
    const asked = live.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(6_200));
    expect(live).toHaveBeenCalledTimes(asked);
  });

  it("is asked for again when a new task starts, which may be in a new browser", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    browserTasks
      .mockResolvedValueOnce(agentDriving())
      .mockResolvedValue(
        snapshot("agent", [task({ id: "task-2" }), task({ status: "finished", output: "x" })]),
      );
    renderPanel();
    await screen.findByTitle("The agent's browser");
    expect(live).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(3_100));
    await waitFor(() => expect(live).toHaveBeenCalledTimes(2));
  });

  /** Review focus 3: a reload loses it, and mounting again is asking again. */
  it("is minted again on every mount", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    const first = renderPanel();
    await screen.findByTitle("The agent's browser");
    first.unmount();

    renderPanel();
    await screen.findByTitle("The agent's browser");
    expect(live).toHaveBeenCalledTimes(2);
    expect(live).toHaveBeenCalledWith("bs-1");
  });
});

describe("the hairline", () => {
  it("breathes while the agent drives", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    const { container } = renderPanel();

    await frameWrapper();
    expect(container.querySelector(".browser-live")).not.toBeNull();
  });

  it("is not there while the person drives", async () => {
    browserTasks.mockResolvedValue(personDriving());
    const { container } = renderPanel();

    await frameWrapper();
    expect(container.querySelector(".browser-live")).toBeNull();
  });

  it("is not there when nothing is running, whatever the row says", async () => {
    // An abandoned take-over can leave `agent` with nothing behind it.
    browserTasks.mockResolvedValue(snapshot("agent", [task({ status: "finished" })]));
    const { container } = renderPanel();

    await frameWrapper();
    expect(container.querySelector(".browser-live")).toBeNull();
  });
});

describe("the pill", () => {
  it("says the agent is using the browser and offers Take over", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    renderPanel();

    expect(await screen.findByText("Agent is using the browser")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take over" })).toBeInTheDocument();
  });

  /**
   * `agent` with nothing queued or running is a take-over the server gave up
   * waiting on, or a row nothing has settled yet. Saying the agent is using the
   * browser would be false, and take-over is idempotent, so it is offered.
   */
  it("does not claim the agent is driving when no run is", async () => {
    browserTasks.mockResolvedValue(snapshot("agent", [task({ status: "finished" })]));
    renderPanel();

    expect(await screen.findByRole("button", { name: "Take over" })).toBeInTheDocument();
    expect(screen.queryByText("Agent is using the browser")).toBeNull();
  });

  it("hands the controls over and re-mints the view", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    renderPanel();
    const wrapper = await frameWrapper();

    await userEvent.click(screen.getByRole("button", { name: "Take over" }));

    expect(takeOver).toHaveBeenCalledWith("bs-1");
    await waitFor(() => expect(wrapper).not.toHaveAttribute("inert"));
    expect(await screen.findByText("You're driving")).toBeInTheDocument();
    await waitFor(() => expect(live).toHaveBeenCalledTimes(2));
  });
});

describe("a take-over the provider has not finished", () => {
  /**
   * 202 `cancelling`: the agent's run was asked to stop and has not said it
   * has. The agent may be mid-keystroke, so the frame stays inert, and asking
   * again is the follow-up — every two seconds, five times, then a button.
   */
  it("stays inert, asks again five times, then offers Try again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    takeOver.mockResolvedValue({ liveState: "cancelling" });
    browserTasks.mockResolvedValue(agentDriving());
    renderPanel();
    const wrapper = await frameWrapper();

    await userEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(takeOver).toHaveBeenCalledTimes(1));
    expect(wrapper).toHaveAttribute("inert");

    for (let i = 0; i < 5; i++) {
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(wrapper).toHaveAttribute("inert");
    }

    await waitFor(() => expect(takeOver).toHaveBeenCalledTimes(6));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(wrapper).toHaveAttribute("inert");
  });

  it("goes interactive once a later ask answers human", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const human = takeOver.getMockImplementation()!;
    takeOver.mockResolvedValueOnce({ liveState: "cancelling" }).mockImplementationOnce(human);
    browserTasks.mockResolvedValue(agentDriving());
    renderPanel();
    const wrapper = await frameWrapper();

    await userEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(takeOver).toHaveBeenCalledTimes(1));
    expect(wrapper).toHaveAttribute("inert");

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await waitFor(() => expect(wrapper).not.toHaveAttribute("inert"));
    expect(takeOver).toHaveBeenCalledTimes(2);
  });
});

describe("Done", () => {
  /**
   * Ruling R21: the sweep stops a browser about ten minutes after the tab
   * that holds it goes quiet. Said where the person is deciding whether to
   * press Done, so walking away is a choice rather than a surprise.
   */
  it("says the browser closes about ten minutes after this tab is closed", async () => {
    browserTasks.mockResolvedValue(personDriving());
    renderPanel();

    await screen.findByRole("button", { name: "Done" });
    expect(
      screen.getByText("The browser closes about ten minutes after this tab is closed."),
    ).toBeInTheDocument();
  });

  it("does not say so while the agent drives", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    renderPanel();

    await screen.findByText("Agent is using the browser");
    expect(screen.queryByText(/ten minutes after this tab is closed/)).toBeNull();
  });

  /**
   * Must-fix minor: in human mode with nothing for the agent to continue —
   * the newest task finished, or is itself the retry — Done can only 409.
   * Close is what the person can actually do, so that is what is offered.
   */
  it.each([
    ["the newest task finished", task({ status: "finished", output: "found it" })],
    [
      "the newest task is already the retry",
      task({ id: "task-2", status: "failed", stopReason: "login_required", retryOf: "task-1" }),
    ],
  ])("offers Close instead when %s", async (_label, newest) => {
    browserTasks.mockResolvedValue(snapshot("human", [newest]));
    renderPanel();

    const close = await screen.findByRole("button", { name: "Close" });
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

    await userEvent.click(close);
    expect(screen.getByRole("button", { name: "Close it" })).toBeInTheDocument();
    expect(handBack).not.toHaveBeenCalled();
  });

  it("hands the browser back to the agent", async () => {
    browserTasks.mockResolvedValue(personDriving());
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(handBack).toHaveBeenCalledWith("bs-1");
    // Back in agent mode before the next poll: the frame is not left
    // interactive under a run that has just been started.
    await waitFor(() => expect(screen.getByTestId("browser-frame")).toHaveAttribute("inert"));
  });

  it("shows a 409 where the button is", async () => {
    handBack.mockRejectedValue(new ApiError(409, "that browser task has already been tried again"));
    browserTasks.mockResolvedValue(personDriving());
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "that browser task has already been tried again",
    );
    expect(screen.getByTestId("browser-frame")).not.toHaveAttribute("inert");
  });
});

describe("the sign-in prompt", () => {
  /** The run's own word for the wall, which settle keeps in `stop_reason`. */
  const wall = (over: Partial<BrowserTask> = {}) =>
    task({ status: "failed", stopReason: "login_required", output: null, ...over });

  it("names the site a failed run needed a sign-in on, and makes Take over primary", async () => {
    browserTasks.mockResolvedValue(snapshot("none", [wall({ signInHost: "linkedin.com" })]));
    renderPanel();

    expect(await screen.findByText("linkedin.com needs you to sign in.")).toBeInTheDocument();
    // The ink fill: the primary button, per DESIGN.md — not amber.
    expect(screen.getByRole("button", { name: "Take over" })).toHaveClass("bg-primary");
  });

  it("says the same with no host when the run named none", async () => {
    browserTasks.mockResolvedValue(snapshot("none", [wall()]));
    renderPanel();

    expect(await screen.findByText("This site needs you to sign in.")).toBeInTheDocument();
  });

  /**
   * `failed` with no `error` is also a block and a run that did not complete
   * but returned text. Neither is a sign-in, and "needs you to sign in" over
   * either sends somebody to do the wrong thing.
   */
  it.each([
    [
      "a run that was blocked",
      task({ status: "failed", stopReason: "blocked", output: "a captcha" }),
    ],
    ["a run that stopped short with text", task({ status: "failed", output: "got halfway" })],
  ])("is not offered for %s", async (_label, row) => {
    browserTasks.mockResolvedValue(snapshot("none", [row]));
    renderPanel();

    await frameWrapper();
    expect(screen.queryByText(/needs you to sign in/)).toBeNull();
    expect(screen.getByRole("button", { name: "Take over" })).not.toHaveClass("bg-primary");
  });

  /**
   * Final-review I2, time-bound: once the browser is known stopped — the
   * sweep cleared it, nothing is running — there is nothing to sign in to,
   * and a prompt that sends somebody to Take over answers only a 409.
   */
  it("is not offered once the browser it would be signed in is known stopped", async () => {
    browserTasks.mockResolvedValue(
      snapshot("none", [wall({ signInHost: "linkedin.com" })], {
        session: { id: "bs-1", liveState: "none", humanSince: null, browserReady: false },
      }),
    );
    live.mockRejectedValue(new ApiError(409, "no browser is open beside this conversation"));
    renderPanel();

    // A stopped browser is no browser to show, so the panel offers one of the
    // person's own instead (Task 3.1, fix round 1) — once the poll has answered.
    await screen.findByRole("button", { name: "Open browser" });
    expect(screen.queryByText(/needs you to sign in/)).toBeNull();
    expect(screen.queryByText("Waiting for you to sign in")).toBeNull();
  });

  it("goes away when a take-over finds the browser gone", async () => {
    browserTasks.mockResolvedValue(snapshot("none", [wall({ signInHost: "linkedin.com" })]));
    takeOver.mockImplementation(async () => {
      browserTasks.mockResolvedValue(
        snapshot("none", [wall({ signInHost: "linkedin.com" })], {
          session: { id: "bs-1", liveState: "none", humanSince: null, browserReady: false },
        }),
      );
      throw new ApiError(409, "the browser beside this conversation has already closed");
    });
    renderPanel();

    await screen.findByText(/linkedin\.com needs you to sign in/);
    await userEvent.click(screen.getByRole("button", { name: "Take over" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("has already closed");
    await waitFor(() => expect(screen.queryByText(/needs you to sign in/)).toBeNull());
  });

  it("is not offered for a task that is already the retry", async () => {
    browserTasks.mockResolvedValue(
      snapshot("none", [wall({ id: "task-2", signInHost: "linkedin.com", retryOf: "task-1" })]),
    );
    renderPanel();

    await frameWrapper();
    expect(screen.queryByText(/needs you to sign in/)).toBeNull();
    expect(screen.getByRole("button", { name: "Take over" })).not.toHaveClass("bg-primary");
  });

  /**
   * Task 2.4: the card replaced the prompt, and "Just this once" is the
   * take-over it always was.
   */
  it("takes over for Just this once", async () => {
    browserTasks.mockResolvedValue(snapshot("none", [wall({ signInHost: "linkedin.com" })]));
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Just this once" }));
    await waitFor(() => expect(takeOver).toHaveBeenCalledWith("bs-1"));
    expect(save).not.toHaveBeenCalled();
  });

  /**
   * R24: a login saved from the card goes with the one free retry. The
   * browser at a wall is nobody's (`none`), and hand-back continues only a
   * browser in the person's hands, so the panel takes it over first — then
   * hands it back naming the site, never the password.
   */
  it("hands back with the site once a login is saved", async () => {
    browserTasks.mockResolvedValue(snapshot("none", [wall({ signInHost: "linkedin.com" })]));
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Save for me" }));
    await userEvent.type(await screen.findByLabelText("Username"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "hunter2-correct-horse");
    await userEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() =>
      expect(handBack).toHaveBeenCalledWith("bs-1", {
        site: "linkedin.com",
        credentialId: "cred-1",
      }),
    );
    expect(save.mock.calls[0][0]).toMatchObject({ agentId: "agent-1", site: "linkedin.com" });
    expect(takeOver).toHaveBeenCalledWith("bs-1");
    expect(takeOver.mock.invocationCallOrder[0]).toBeLessThan(handBack.mock.invocationCallOrder[0]);
    expect(JSON.stringify(handBack.mock.calls)).not.toContain("hunter2");
  });

  it("says when the run carried a saved login that did not work", async () => {
    browserTasks.mockResolvedValue(
      snapshot("none", [wall({ signInHost: "linkedin.com", carriedSavedLogin: true })]),
    );
    renderPanel();

    expect(
      await screen.findByText("The saved login for linkedin.com didn't get past the sign-in."),
    ).toBeInTheDocument();
  });
});

describe("closing", () => {
  /**
   * Stop does not cancel a run, and a run whose browser vanished under it
   * settles as a failure — so while the agent drives, close only hides.
   */
  it("only hides the panel while a run is going", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    const { onHide } = renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Close the browser" }));
    expect(onHide).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  /**
   * Ruling R50: the stop route refuses while the row says the agent has the
   * browser, run or no run — so the panel's close hides there too, rather
   * than asking "Close the browser?" and then showing the server's 409.
   */
  it("only hides the panel while the agent holds the browser, even with no run going", async () => {
    browserTasks.mockResolvedValue(
      snapshot("agent", [task({ status: "finished", output: "found it" })]),
    );
    const { onHide } = renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Close the browser" }));
    expect(onHide).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(screen.queryByText(/close the browser\?/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops the browser otherwise, after saying the sign-ins are kept", async () => {
    browserTasks.mockResolvedValue(personDriving());
    const { onHide } = renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Close the browser" }));
    expect(stop).not.toHaveBeenCalled();
    expect(
      screen.getByText("Close the browser? Closing it saves your sign-ins to your profile."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close it" }));
    expect(stop).toHaveBeenCalledWith("bs-1");
    await waitFor(() => expect(onHide).toHaveBeenCalled());
  });

  it("keeps it open when the person thinks better of it", async () => {
    browserTasks.mockResolvedValue(idle());
    const { onHide } = renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Close the browser" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep it open" }));
    expect(stop).not.toHaveBeenCalled();
    expect(onHide).not.toHaveBeenCalled();
    expect(screen.queryByText(/saves your sign-ins/i)).toBeNull();
  });
});

describe("what the agent did", () => {
  it("lists the events newest last, keeping earlier polls' lines", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    browserTasks
      .mockResolvedValueOnce(
        snapshot("agent", [task()], {
          events: [{ ts: "1", type: "step", text: "Opened the portal" }],
        }),
      )
      .mockResolvedValue(
        snapshot("agent", [task()], {
          events: [{ ts: "2", type: "step", text: "Clicked Invoices" }],
        }),
      );
    renderPanel();

    await screen.findByText("Opened the portal");
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    await screen.findByText("Clicked Invoices");

    const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual(["Opened the portal", "Clicked Invoices"]);
  });
});

/**
 * Task 3.1: a browser of your own, opened from the chat header to sign in
 * ahead of time, so the agent's browser later finds you signed in.
 *
 * The same rules as the agent's browser where they apply — the URL is a
 * credential held in component state, the frame is the person's to touch —
 * and three of its own: nothing is rented until the person presses Open
 * browser, a takeover that belongs to a task is the transcript card's and not
 * this panel's (ruling R43), and Done is the close that saves the jar.
 */
describe("a browser of your own (Task 3.1)", () => {
  const noBrowser = (): ConversationBrowser => ({
    tasks: [],
    session: null,
    events: [],
    delivered: false,
  });
  const inTen = () => new Date(Date.now() + 10 * 60_000).toISOString();

  async function openIt() {
    await userEvent.click(await screen.findByRole("button", { name: "Open browser" }));
    return screen.findByTitle("Your browser");
  }

  it("offers Open browser in a conversation with no browser, and rents nothing until it is pressed", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    renderPanel();

    expect(await screen.findByRole("button", { name: "Open browser" })).toBeInTheDocument();
    expect(screen.getByText(/sign in to sites ahead of time/i)).toBeInTheDocument();
    expect(takeoverOpen).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Your browser")).toBeNull();
    // Nor the agent's pill: there is no agent here to take over from.
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("opens it in the panel, in the person's hands", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    renderPanel();

    const frame = await openIt();
    expect(frame).toHaveAttribute("src", SECRET);
    expect(takeoverOpen).toHaveBeenCalledTimes(1);
    const wrapper = screen.getByTestId("browser-frame");
    expect(wrapper).not.toHaveAttribute("inert");
    expect(wrapper).not.toHaveAttribute("tabindex");
    expect(wrapper).not.toHaveClass("pointer-events-none");
    expect(screen.getByText("You are using the browser")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("says how long is left of its window", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    takeoverOpen.mockResolvedValue({
      id: "to-1",
      liveUrl: SECRET,
      expiresAt: new Date(Date.now() + 9 * 60_000 + 30_000).toISOString(),
    });
    renderPanel();

    await openIt();
    expect(screen.getByText(/^9:[23]\d left/)).toBeInTheDocument();
  });

  it("says so once the window is up, and still offers Done", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    takeoverCurrent.mockResolvedValue({
      takeover: {
        id: "to-1",
        browserTaskId: null,
        liveUrl: SECRET,
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();

    await screen.findByTitle("Your browser");
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    // Ruling R49: no more urgent than is true. The sweep's stop saves the jar
    // as Done's does, so a lapsed window loses nothing.
    expect(
      await screen.findByText(
        "Time is up. Press Done to finish; if you don't, it closes by itself shortly and your sign-ins are still saved.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/press Done now/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("keeps the live URL in no query cache, no storage and no text", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    const { client, container } = renderPanel();

    await openIt();
    const queries = client
      .getQueryCache()
      .getAll()
      .map((q) => ({ key: q.queryKey, data: q.state.data }));
    const mutations = client
      .getMutationCache()
      .getAll()
      .map((m) => ({ key: m.options.mutationKey, data: m.state.data, vars: m.state.variables }));
    expect(JSON.stringify(queries)).not.toContain("secret-address");
    expect(JSON.stringify(mutations)).not.toContain("secret-address");
    const stored = [localStorage, sessionStorage].flatMap((s) =>
      Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i) ?? "")}`),
    );
    expect(stored.join("\n")).not.toContain("secret-address");
    expect(container.textContent ?? "").not.toContain("secret-address");
  });

  /** Review focus 3, for this browser: a reload re-mints it from the row. */
  it("gets it back after a reload, without renting another", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    takeoverCurrent.mockResolvedValue({
      takeover: { id: "to-1", browserTaskId: null, liveUrl: SECRET, expiresAt: inTen() },
    });
    renderPanel();

    expect(await screen.findByTitle("Your browser")).toHaveAttribute("src", SECRET);
    expect(takeoverOpen).not.toHaveBeenCalled();
  });

  /**
   * Ruling R51 (b): after a reload past the window, `current` answers the
   * still-open row, and the panel shows it with its Done and the "Time is
   * up" line — not Open browser beside a refusal to press Done somewhere.
   */
  it("gets a browser past its window back after a reload, with Done", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    takeoverCurrent.mockResolvedValue({
      takeover: {
        id: "to-1",
        browserTaskId: null,
        liveUrl: SECRET,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    renderPanel();

    expect(await screen.findByTitle("Your browser")).toHaveAttribute("src", SECRET);
    expect(screen.getByText(/^Time is up\. Press Done to finish/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open browser" })).toBeNull();
  });

  /** Ruling R43: the two never both claim one takeover. */
  it("leaves a task's takeover to the card in the transcript", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    takeoverCurrent.mockResolvedValue({
      takeover: { id: "to-9", browserTaskId: "task-9", liveUrl: SECRET, expiresAt: inTen() },
    });
    renderPanel();

    expect(await screen.findByRole("button", { name: "Open browser" })).toBeInTheDocument();
    expect(screen.queryByTitle("Your browser")).toBeNull();
  });

  /**
   * Fix round 1 (review): a conversation that has ever browsed keeps its
   * `browser_sessions` row after the idle stop, reported with `browserReady:
   * false`. "No browser yet" has to include that, or Open browser is
   * unreachable in every conversation that ever used one (ruling R42).
   */
  it("offers Open browser beside a conversation browser that has been stopped", async () => {
    browserTasks.mockResolvedValue(
      snapshot("none", [task({ status: "finished", output: "found it" })], {
        session: { id: "bs-1", liveState: "none", humanSince: null, browserReady: false },
      }),
    );
    renderPanel();

    expect(await screen.findByRole("button", { name: "Open browser" })).toBeInTheDocument();
    expect(takeoverOpen).not.toHaveBeenCalled();
  });

  /** Fix round 1, item 5: a race must never hide a live conversation browser and its controls. */
  it.each([
    ["the agent is driving", agentDriving, "Take over"],
    ["the person is driving", personDriving, "Done"],
  ])("never hides a conversation browser while %s", async (_label, make, control) => {
    browserTasks.mockResolvedValue(make());
    takeoverCurrent.mockResolvedValue({
      takeover: { id: "to-1", browserTaskId: null, liveUrl: SECRET, expiresAt: inTen() },
    });
    renderPanel();

    expect(await screen.findByTitle("The agent's browser")).toBeInTheDocument();
    await waitFor(() => expect(takeoverCurrent).toHaveBeenCalled());
    // Let its answer land, so what follows is the view after it, not before.
    await act(async () => {});
    expect(screen.queryByTitle("Your browser")).toBeNull();
    expect(screen.getByRole("button", { name: control })).toBeInTheDocument();
  });

  it("is shown over a conversation browser nobody is using, so its Done can be found", async () => {
    browserTasks.mockResolvedValue(idle());
    takeoverCurrent.mockResolvedValue({
      takeover: { id: "to-1", browserTaskId: null, liveUrl: SECRET, expiresAt: inTen() },
    });
    renderPanel();

    expect(await screen.findByTitle("Your browser")).toBeInTheDocument();
    expect(screen.queryByTitle("The agent's browser")).toBeNull();
  });

  it("Done closes it, which is what saves the sign-ins, and says so", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    renderPanel();

    await openIt();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(takeoverClose).toHaveBeenCalledWith("to-1");
    expect(await screen.findByText(/your sign-ins are saved/i)).toBeInTheDocument();
    expect(screen.queryByTitle("Your browser")).toBeNull();
    expect(screen.getByRole("button", { name: "Open browser" })).toBeInTheDocument();
  });

  it("closing the panel asks first, and closing the browser is Done", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    const { onHide } = renderPanel();

    await openIt();
    await userEvent.click(screen.getByRole("button", { name: "Close the browser" }));
    expect(screen.getByText(/closing it saves your sign-ins/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close it" }));

    expect(takeoverClose).toHaveBeenCalledWith("to-1");
    await waitFor(() => expect(onHide).toHaveBeenCalled());
  });

  it("treats a browser the sweep already closed as closed", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    takeoverClose.mockRejectedValue(new ApiError(409, "that takeover is already closed"));
    renderPanel();

    await openIt();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    // Every way a takeover is closed stops its browser — Done, the sweep, a
    // new Open over a lapsed one — and the stop is what saves the jar.
    expect(
      await screen.findByText(
        "This browser has already been closed, and your sign-ins were saved.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTitle("Your browser")).toBeNull();
  });

  /**
   * M4: one already open — in another tab, say, opened after this panel
   * mounted. The 409 is not the end of it: the panel asks which browser is
   * open, and a task-less one is this panel's to show (ruling R43).
   */
  it("adopts the browser a 409 says is already open, when it is the person's own", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    takeoverOpen.mockRejectedValue(
      new ApiError(
        409,
        "You already have a browser open. Finish signing in and press Done in that one.",
      ),
    );
    renderPanel();
    await waitFor(() => expect(takeoverCurrent).toHaveBeenCalledTimes(1));
    takeoverCurrent.mockResolvedValue({
      takeover: { id: "to-2", browserTaskId: null, liveUrl: SECRET, expiresAt: inTen() },
    });

    await userEvent.click(await screen.findByRole("button", { name: "Open browser" }));

    expect(await screen.findByTitle("Your browser")).toHaveAttribute("src", SECRET);
    expect(takeoverCurrent).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("says the 409 when the browser already open is a task's, which is not this panel's", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    takeoverOpen.mockRejectedValue(
      new ApiError(
        409,
        "You already have a browser open. Finish signing in and press Done in that one.",
      ),
    );
    renderPanel();
    await waitFor(() => expect(takeoverCurrent).toHaveBeenCalledTimes(1));
    takeoverCurrent.mockResolvedValue({
      takeover: { id: "to-9", browserTaskId: "task-9", liveUrl: SECRET, expiresAt: inTen() },
    });

    await userEvent.click(await screen.findByRole("button", { name: "Open browser" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/^You already have a browser open/);
    expect(takeoverCurrent).toHaveBeenCalledTimes(2);
    expect(screen.queryByTitle("Your browser")).toBeNull();
  });

  it("says a refusal where the button is", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    takeoverOpen.mockRejectedValue(
      new ApiError(409, "a browser of yours is in use beside a conversation right now"),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Open browser" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/in use beside a conversation/);
    expect(screen.queryByTitle("Your browser")).toBeNull();
  });

  /** DESIGN.md: the breathing edge is the agent's, only while its run is going. */
  it("does not breathe the amber edge, which is the agent's", async () => {
    browserTasks.mockResolvedValue(noBrowser());
    const { container } = renderPanel();

    await openIt();
    expect(container.querySelector(".browser-live")).toBeNull();
    expect(container.querySelector(".bg-accent-orange")).not.toBeNull();
  });
});

/**
 * 0080: the browser's line. What starts by itself when the browser is free,
 * next first, each with a way out before its turn — and the close says what
 * it takes with it.
 */
describe("tasks waiting their turn", () => {
  const waitingTask = (id: string, text: string) =>
    task({ id, task: text, status: "waiting", stopReason: null });
  const withLine = () =>
    snapshot("agent", [
      waitingTask("w2", "review tasklet.ai"),
      waitingTask("w1", "review covan.app"),
      task(),
    ]);

  it("lists them next first, under the browser", async () => {
    browserTasks.mockResolvedValue(withLine());
    renderPanel();

    const list = await screen.findByRole("region", { name: "Queued tasks" });
    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Up next");
    expect(items[0].textContent).toContain("review covan.app");
    expect(items[1].textContent).toContain("Second in line");
    expect(items[1].textContent).toContain("review tasklet.ai");
  });

  it("takes one out of the line, and asks again", async () => {
    browserTasks.mockResolvedValue(withLine());
    renderPanel();

    await screen.findByRole("region", { name: "Queued tasks" });
    const before = browserTasks.mock.calls.length;
    await userEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);

    expect(removeWaiting).toHaveBeenCalledWith("w1");
    await waitFor(() => expect(browserTasks.mock.calls.length).toBeGreaterThan(before));
  });

  it("says why one could not be removed: it started meanwhile", async () => {
    browserTasks.mockResolvedValue(withLine());
    removeWaiting.mockRejectedValue(
      new Error("That task has already started, so it can't be taken out of the line."),
    );
    renderPanel();

    await screen.findByRole("region", { name: "Queued tasks" });
    await userEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);

    expect(await screen.findByRole("alert")).toHaveTextContent(/already started/);
  });

  it("warns that closing an idle browser drops what waits for it", async () => {
    browserTasks.mockResolvedValue(
      snapshot("none", [
        waitingTask("w1", "review covan.app"),
        task({ status: "failed", stopReason: "login_required", signInHost: "x.com" }),
      ]),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Close the browser" }));
    expect(screen.getByText(/The task waiting for it won't run\./)).toBeInTheDocument();
  });

  it("shows no list when nothing waits", async () => {
    browserTasks.mockResolvedValue(agentDriving());
    renderPanel();

    await screen.findByTitle("The agent's browser");
    expect(screen.queryByRole("region", { name: "Queued tasks" })).toBeNull();
  });
});

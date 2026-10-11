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

vi.mock("@/lib/api-client", () => ({
  api: {
    sessions: { browserTasks: (...a: unknown[]) => browserTasks(...a) },
    browser: {
      live: (...a: unknown[]) => live(...a),
      takeOver: (...a: unknown[]) => takeOver(...a),
      handBack: (...a: unknown[]) => handBack(...a),
      stop: (...a: unknown[]) => stop(...a),
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
      <BrowserPanel sessionId="s-1" onHide={onHide} />
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

    expect(
      await screen.findByText(
        "linkedin.com needs you to sign in. Take over, sign in in the browser, then press Done.",
      ),
    ).toBeInTheDocument();
    // The ink fill: the primary button, per DESIGN.md — not amber.
    expect(screen.getByRole("button", { name: "Take over" })).toHaveClass("bg-primary");
  });

  it("says the same with no host when the run named none", async () => {
    browserTasks.mockResolvedValue(snapshot("none", [wall()]));
    renderPanel();

    expect(
      await screen.findByText(
        "This site needs you to sign in. Take over, sign in in the browser, then press Done.",
      ),
    ).toBeInTheDocument();
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

    // The header's window control appears once the poll has answered a session.
    await screen.findByRole("button", { name: "Open in new window" });
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

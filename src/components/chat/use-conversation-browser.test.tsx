import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationBrowser } from "@/lib/api-client";
import { browserKey, useBrowserPanel } from "./use-conversation-browser";

/**
 * When the panel opens and shuts by itself. The chat route's tests cover what
 * a person sees; these drive the hook's inputs directly — a window crossing
 * `lg`, a conversation switch — which a rendered page cannot easily do.
 */

const browserTasks = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: { sessions: { browserTasks: (...a: unknown[]) => browserTasks(...a) } },
}));

function browser(taskId: string, status: string, liveState = "agent"): ConversationBrowser {
  return {
    tasks: [
      {
        id: taskId,
        task: "read the page",
        status,
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
    session: { id: "bs-1", liveState, humanSince: null, browserReady: true },
    events: [],
    delivered: false,
  } as unknown as ConversationBrowser;
}

const running = (taskId = "task-1") => browser(taskId, "running");
const finished = (taskId = "task-1") => browser(taskId, "finished", "none");

function setup(initial: ConversationBrowser, props = { sessionId: "chat-1", narrow: false }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  browserTasks.mockResolvedValue(initial);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    (p: { sessionId: string; narrow: boolean }) => useBrowserPanel(p.sessionId, p.narrow),
    {
      wrapper,
      initialProps: props,
    },
  );
  /** What the next poll answers, written straight into the cache. */
  const answer = async (data: ConversationBrowser, sessionId = "chat-1") => {
    browserTasks.mockResolvedValue(data);
    await act(async () => {
      client.setQueryData(browserKey(sessionId), data);
    });
  };
  return { ...hook, answer };
}

beforeEach(() => {
  browserTasks.mockReset();
  // Cache writes notify on a timer by default, after `act` has returned, so a
  // test reading the hook straight after one would read the render before it.
  notifyManager.setScheduler((cb) => cb());
});

afterEach(() => {
  notifyManager.setScheduler((cb) => setTimeout(cb, 0));
});

describe("useBrowserPanel", () => {
  it("stays open after the run that opened it finishes", async () => {
    const { result, answer } = setup(running());
    await waitFor(() => expect(result.current.open).toBe(true));

    await answer(finished());
    expect(result.current.open).toBe(true);
  });

  it("does not stay over a window that narrows below lg, and comes back when it widens", async () => {
    const { result, rerender, answer } = setup(running());
    await waitFor(() => expect(result.current.open).toBe(true));
    await answer(finished());

    rerender({ sessionId: "chat-1", narrow: true });
    expect(result.current.open).toBe(false);

    rerender({ sessionId: "chat-1", narrow: false });
    expect(result.current.open).toBe(true);
  });

  it("stays over a narrow window when the person opened it there", async () => {
    const { result, answer } = setup(finished(), { sessionId: "chat-1", narrow: true });
    await waitFor(() => expect(browserTasks).toHaveBeenCalled());
    act(() => result.current.show());
    await answer(running("task-2"));
    expect(result.current.open).toBe(true);
  });

  it("stays shut for the run it was closed on, and opens for a newer one", async () => {
    const { result, answer } = setup(running());
    await waitFor(() => expect(result.current.open).toBe(true));

    act(() => result.current.hide());
    expect(result.current.open).toBe(false);
    await answer(finished());
    expect(result.current.open).toBe(false);

    await answer(running("task-2"));
    expect(result.current.open).toBe(true);
    await answer(finished("task-2"));
    expect(result.current.open).toBe(true);
  });

  it("starts again in another conversation", async () => {
    const { result, rerender, answer } = setup(running());
    await waitFor(() => expect(result.current.open).toBe(true));
    await answer(finished());

    browserTasks.mockResolvedValue(finished("task-9"));
    rerender({ sessionId: "chat-2", narrow: false });
    await waitFor(() => expect(browserTasks).toHaveBeenCalledWith("chat-2"));
    expect(result.current.open).toBe(false);
  });
});

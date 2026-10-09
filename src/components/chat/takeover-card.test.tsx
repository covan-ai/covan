import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrowserTask, Takeover } from "@/lib/api-client";
import { TakeoverCard } from "./takeover-card";

/**
 * What matters here is which tasks get a button and what happens to the live
 * URL, because one bounds the operator's money and the other is a credential.
 */

const browserTasks = vi.fn();
const takeOver = vi.fn();
const current = vi.fn();
const close = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    sessions: { browserTasks: (...a: unknown[]) => browserTasks(...a) },
    browser: {
      takeOver: (...a: unknown[]) => takeOver(...a),
      current: (...a: unknown[]) => current(...a),
      close: (...a: unknown[]) => close(...a),
    },
  },
}));

const toastCalls: string[] = [];
vi.mock("sonner", () => ({
  toast: {
    error: (m: string) => toastCalls.push(`error:${m}`),
    success: (m: string) => toastCalls.push(`success:${m}`),
    info: (m: string) => toastCalls.push(`info:${m}`),
  },
}));

function task(over: Partial<BrowserTask> = {}): BrowserTask {
  return {
    id: "task-1",
    task: "read my invoices on the supplier portal",
    status: "failed",
    output: "could not sign in",
    error: null,
    retryOf: null,
    createdAt: 0,
    finishedAt: null,
    ...over,
  };
}

const LIVE: Takeover = {
  id: "to-1",
  browserTaskId: "task-1",
  liveUrl: "https://live.browser-use.com/secret-address",
  expiresAt: new Date(Date.now() + 9 * 60_000 + 30_000).toISOString(),
};

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TakeoverCard sessionId="s-1" />
    </QueryClientProvider>,
  );
}

let opened: {
  location: { replace: ReturnType<typeof vi.fn> };
  closed: boolean;
  opener: unknown;
  close: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  toastCalls.length = 0;
  browserTasks.mockResolvedValue({ tasks: [] });
  current.mockResolvedValue({ takeover: null });
  takeOver.mockResolvedValue(LIVE);
  close.mockResolvedValue({
    retriedTaskId: "task-2",
    cookieDomains: ["portal.example.com"],
    message: "trying again now",
  });
  opened = { location: { replace: vi.fn() }, closed: false, opener: {}, close: vi.fn() };
  vi.stubGlobal(
    "open",
    vi.fn(() => opened),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("which tasks are offered", () => {
  it("offers a failed task that said something", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    renderCard();

    expect(await screen.findByRole("button", { name: /sign in myself/i })).toBeTruthy();
  });

  /**
   * The ordinary happy path, and the one this card used to get wrong for ever:
   * after a takeover and a SUCCESSFUL retry the original row is still `failed`,
   * still has `output` and still has `retryOf: null`, so without looking across
   * the list the card kept offering "That needed a sign-in" — and clicking it
   * rented a real browser before the insert failed on the unique index.
   */
  it("offers nothing once a successor exists", async () => {
    browserTasks.mockResolvedValue({
      tasks: [task({ id: "task-2", retryOf: "task-1", status: "running", output: null }), task()],
    });
    renderCard();

    await waitFor(() => expect(browserTasks).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /sign in myself/i })).toBeNull();
  });

  it.each([
    ["a task that finished", task({ status: "finished" })],
    // Nothing to sign into: it never reached a page.
    ["a failure with no output", task({ output: null })],
    // THE bound on operator spend. A retry is never itself offerable.
    ["a task that is already a retry", task({ retryOf: "task-0" })],
  ])("offers nothing for %s", async (_label, row) => {
    browserTasks.mockResolvedValue({ tasks: [row] });
    renderCard();

    await waitFor(() => expect(browserTasks).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /sign in myself/i })).toBeNull();
  });
});

describe("opening the browser", () => {
  it("reserves the tab inside the click, then navigates it", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /sign in myself/i }));

    // Opened empty and synchronously, because Safari blocks a window.open
    // that is not a direct consequence of a gesture and the address does not
    // exist until the request comes back.
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(opened.location.replace).toHaveBeenCalledWith(LIVE.liveUrl));
    // Nulled rather than opened with `noopener`, which would have returned
    // null and left nothing to navigate.
    expect(opened.opener).toBeNull();
  });

  it("says nothing is saved until done is pressed", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /sign in myself/i }));

    expect(await screen.findByText(/nothing is saved until you press done/i)).toBeTruthy();
  });

  it("shows a countdown rather than a one-time sentence", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /sign in myself/i }));

    // Ten minutes is tight, and somebody waiting on a 2FA text needs to see
    // how much of it is left.
    expect(await screen.findByText(/9:\d\d left/)).toBeTruthy();
  });

  it("closes the reserved tab when the request fails", async () => {
    takeOver.mockRejectedValue(new Error("every browser this deployment can run is busy"));
    browserTasks.mockResolvedValue({ tasks: [task()] });
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /sign in myself/i }));

    await waitFor(() => expect(toastCalls.some((t) => t.startsWith("error:"))).toBe(true));
  });
});

describe("a reloaded tab", () => {
  /**
   * The likeliest day-one failure without this: the URL exists only in the
   * response that minted it and one open takeover is allowed, so a reload
   * would lock somebody out of their own signed-in browser for the rest of the
   * window — and the waiting is what destroys the login.
   */
  /**
   * `GET /browser/takeovers/current` is per-PERSON, so it answers the same row
   * in every conversation. Rendering it wherever it was found put the panel in
   * all of them, and pressing done in the wrong one re-ran the task into a
   * conversation nobody was looking at.
   */
  it("does not show a takeover that belongs to another conversation", async () => {
    // This conversation HAS a browser task — otherwise the query would be
    // skipped and the absence of the panel would prove nothing — but it is a
    // different task from the one the standing takeover names.
    browserTasks.mockResolvedValue({ tasks: [task({ id: "task-9" })] });
    current.mockResolvedValue({ takeover: LIVE });
    renderCard();

    /**
     * Waited on the OFFER, not on the query having been called.
     *
     * `waitFor(() => expect(current).toHaveBeenCalled())` resolves the moment
     * the request goes out — before its answer lands and before React has
     * rendered anything with it — so a `queryByRole` after it asserts against
     * a screen the takeover could not have reached yet. It passed with the
     * scoping check deleted. This task is offerable, so the offer card is
     * proof that both answers arrived AND that the panel lost: had the
     * takeover been accepted, the early `if (takeover)` return would have
     * replaced this button rather than sat beside it.
     */
    expect(await screen.findByRole("button", { name: /sign in myself/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /done, i've signed in/i })).toBeNull();
  });

  it("recovers the open takeover from the server", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    current.mockResolvedValue({ takeover: LIVE });
    renderCard();

    expect(await screen.findByRole("button", { name: /done, i've signed in/i })).toBeTruthy();
    expect(await screen.findByText(/9:\d\d left/)).toBeTruthy();
  });
});

describe("pressing done", () => {
  /**
   * The toast says whether it worked, and nothing about domains.
   *
   * It used to list them, and the first real run returned seven for one
   * LinkedIn sign-in — five of them ad-tech the page had dropped. "Signed in
   * to facebook.com, demdex.net, 33across.com" after somebody logged into
   * LinkedIn is false and frightening at once. The list, correctly labelled,
   * is on the account screen where there is room to say what it is.
   */
  it("reports whether it worked, without naming domains it cannot explain", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    current.mockResolvedValue({ takeover: LIVE });
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /done, i've signed in/i }));

    await waitFor(() => expect(toastCalls.some((t) => t.includes("trying again now"))).toBe(true));
    expect(toastCalls.some((t) => t.includes("portal.example.com"))).toBe(false);
    expect(toastCalls.some((t) => /signed in to/i.test(t))).toBe(false);
  });

  it("does not resurrect the takeover from a stale server answer", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    current.mockResolvedValue({ takeover: LIVE });
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: /done, i've signed in/i }));

    await waitFor(() => expect(close).toHaveBeenCalledWith("to-1"));
    // `current` still answers with the row it had; the card must not come back.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /done, i've signed in/i })).toBeNull(),
    );
  });
});

describe("the live URL", () => {
  it("is never rendered as plain text, only as the link's address", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    current.mockResolvedValue({ takeover: LIVE });
    const { container } = renderCard();

    await screen.findByRole("button", { name: /done, i've signed in/i });
    // A credential: anyone with it can drive that browser. It may be an href
    // and nothing else — not body text somebody screenshots into a ticket.
    expect(container.textContent ?? "").not.toContain("secret-address");
  });
});

describe("what it asks for", () => {
  /**
   * Two requests per chat open that could not produce anything: `belongsHere`
   * discards a standing takeover whose task is not in this conversation, so an
   * empty list makes the answer irrelevant whatever it is. On a deployment
   * with no `BROWSER_USE_API_KEY` that is every chat open there will ever be.
   */
  it("does not ask for a takeover in a conversation with no browser tasks", async () => {
    browserTasks.mockResolvedValue({ tasks: [] });
    renderCard();

    await waitFor(() => expect(browserTasks).toHaveBeenCalled());
    expect(current).not.toHaveBeenCalled();
  });

  it("asks once the conversation has one", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    renderCard();

    await waitFor(() => expect(current).toHaveBeenCalled());
  });
});

describe("what the offer promises", () => {
  /**
   * Added after the first real run. A hand-performed LinkedIn sign-in saved
   * correctly, attached to the re-run correctly, ran from another address in
   * the same country, and LinkedIn asked for the password again. The person
   * deciding whether to go and sign in is the one who should know that before
   * they spend the time, not after.
   */
  it("does not promise the second attempt gets in", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    const { container } = renderCard();

    await screen.findByRole("button", { name: /sign in myself/i });
    expect(container.textContent).toMatch(/tie a sign-in to one network address/i);
  });

  it("still says the second attempt is free, because it is", async () => {
    browserTasks.mockResolvedValue({ tasks: [task()] });
    const { container } = renderCard();

    await screen.findByRole("button", { name: /sign in myself/i });
    expect(container.textContent).toMatch(/no charge for the second attempt/i);
  });
});

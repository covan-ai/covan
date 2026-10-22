import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserSignInsSection } from "./browser-signins-section";

/**
 * What matters here is that the section is honest about what is held and
 * refuses to pretend a deletion happened. The sites are the only thing Covan
 * can say about somebody's logins at all, so saying them wrong is the whole
 * failure available to this component.
 */
const { profile, forget, listLogins, openBrowsers, stop, FakeApiError } = vi.hoisted(() => ({
  profile: vi.fn(),
  forget: vi.fn(),
  listLogins: vi.fn(),
  openBrowsers: vi.fn(),
  stop: vi.fn(),
  FakeApiError: class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    browser: { profile, forget, open: openBrowsers, stop, credentials: { list: listLogins } },
    takeovers: { close: vi.fn() },
  },
  ApiError: FakeApiError,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BrowserSignInsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  profile.mockResolvedValue({
    profile: { cookieDomains: ["portal.example.com"], createdAt: null, lastUsedAt: null },
  });
  forget.mockResolvedValue({ forgotten: ["portal.example.com"] });
  listLogins.mockResolvedValue({ logins: [] });
  openBrowsers.mockResolvedValue({ browsers: [], takeover: null });
  stop.mockResolvedValue(undefined);
});

describe("BrowserSignInsSection", () => {
  it("names the sites a jar is holding", async () => {
    renderSection();
    expect(await screen.findByText("portal.example.com")).toBeTruthy();
  });

  it("says Covan never receives the password, which is the reason the jar exists", async () => {
    renderSection();
    expect(await screen.findByText(/never receives your password/i)).toBeTruthy();
  });

  /**
   * A section about forgetting logins that do not exist is noise on a page
   * that already has eight of them.
   */
  it("renders nothing at all when no jar is held", async () => {
    profile.mockResolvedValue({ profile: null });
    const { container } = renderSection();

    await waitFor(() => expect(profile).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /forget these sign-ins/i })).toBeNull();
    expect(container.textContent).toBe("");
  });

  /** A profile exists but nothing has been saved into it yet — a real state. */
  it("distinguishes an empty jar from no jar", async () => {
    profile.mockResolvedValue({
      profile: { cookieDomains: [], createdAt: null, lastUsedAt: null },
    });
    renderSection();

    // Not "nothing saved": the provider can save a jar and not report it.
    expect(await screen.findByText(/no sites are listed yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /forget these sign-ins/i })).toBeTruthy();
  });

  it("forgets them once confirmed", async () => {
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: /forget these sign-ins/i }));
    await userEvent.click(screen.getByRole("button", { name: /forget them/i }));

    await waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
  });

  it("does not forget anything on the trigger alone", async () => {
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: /forget these sign-ins/i }));

    expect(forget).not.toHaveBeenCalled();
  });

  /**
   * The 409: a browser of theirs is open, and stopping it is what saves the
   * jar. The reason stays in the dialog because it is an instruction about
   * what to go and do.
   */
  it("keeps the dialog open with the server's reason when a browser is still open", async () => {
    forget.mockRejectedValue(new FakeApiError(409, "a browser of yours is open right now"));
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: /forget these sign-ins/i }));
    await userEvent.click(screen.getByRole("button", { name: /forget them/i }));

    expect(await screen.findByText(/a browser of yours is open right now/i)).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

/**
 * Task 2.4: the logins a person chose to save are their own section — shown
 * whether or not a cookie jar exists, and never with a username.
 */
describe("Saved logins", () => {
  const LOGIN = {
    id: "cred-1",
    agentId: "agent-1",
    label: "Supplier portal — personal",
    siteHost: "portal.example.com",
    scope: "owner",
    lastUsedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    own: true,
    canForget: true,
  };

  it("lists them under their own heading, even with no jar", async () => {
    profile.mockResolvedValue({ profile: null });
    listLogins.mockResolvedValue({ logins: [LOGIN] });
    renderSection();

    expect(await screen.findByText(/Saved sign-ins · 1/)).toBeTruthy();
    expect(screen.getByText("Supplier portal — personal")).toBeTruthy();
    expect(listLogins).toHaveBeenCalledWith(undefined);
  });

  /**
   * Final review #5: "the AI model never sees them" was absolute, and the
   * provider's own browsing agent can see a typed value. What Covan controls
   * is what Covan's model is given.
   */
  it("says Covan's AI model is never given them, and no more than that", async () => {
    listLogins.mockResolvedValue({ logins: [LOGIN] });
    const { container } = renderSection();

    await screen.findByText(/Saved sign-ins/);
    expect(container.textContent).toContain("Encrypted; Covan's AI model is never given them.");
    expect(container.textContent).not.toContain("the AI model never sees them");
  });

  it("never shows a username", async () => {
    listLogins.mockResolvedValue({ logins: [{ ...LOGIN, username: "ada@example.com" }] });
    const { container } = renderSection();

    await screen.findByText("Supplier portal — personal");
    expect(container.textContent).not.toContain("ada@example.com");
  });
});

/**
 * Task 3.2 (ruling R48): the person's open browsers, the third part. Stopping
 * one is what saves its sign-ins, so the sites above are asked for again.
 */
describe("Open browsers", () => {
  const IDLE = {
    id: "bs-idle",
    conversation: { id: "chat-3", title: "Compare plans" },
    agent: { id: "agent-2", name: "Scout" },
    liveState: "none",
    running: false,
    stoppable: true,
    browserOpen: true,
    lastUsedAt: new Date().toISOString(),
  };

  it("lists them under their own heading, even with no jar", async () => {
    profile.mockResolvedValue({ profile: null });
    openBrowsers.mockResolvedValue({ browsers: [IDLE], takeover: null });
    renderSection();

    expect(await screen.findByText("Open browsers")).toBeTruthy();
    expect(screen.getByText("Compare plans")).toBeTruthy();
  });

  it("asks for the sites again after a stop, which is what saved them", async () => {
    openBrowsers.mockResolvedValue({ browsers: [IDLE], takeover: null });
    renderSection();

    await screen.findByText("Compare plans");
    const before = profile.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await userEvent.click(await screen.findByRole("button", { name: "Stop it" }));

    expect(stop).toHaveBeenCalledWith("bs-idle");
    await waitFor(() => expect(profile.mock.calls.length).toBeGreaterThan(before));
  });
});

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
const { profile, forget, FakeApiError } = vi.hoisted(() => ({
  profile: vi.fn(),
  forget: vi.fn(),
  FakeApiError: class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/api-client", () => ({
  api: { browser: { profile, forget } },
  ApiError: FakeApiError,
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
    profile: { signedInTo: ["portal.example.com"], createdAt: null, lastUsedAt: null },
  });
  forget.mockResolvedValue({ forgotten: ["portal.example.com"] });
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
      profile: { signedInTo: [], createdAt: null, lastUsedAt: null },
    });
    renderSection();

    expect(await screen.findByText(/no sign-ins have been saved yet/i)).toBeTruthy();
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

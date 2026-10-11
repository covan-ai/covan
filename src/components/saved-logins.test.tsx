import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SavedLogin } from "@/lib/api-client";
import { SavedLoginsList } from "./saved-logins";

/**
 * The saved logins a person can see, on their settings and on an agent's.
 *
 * The screen's one hard rule is the plan's: label, host, scope, last used,
 * Forget — never a username. The server has none to send; the list renders
 * named fields only, so a field that should not be there is not drawn even
 * if a response ever carried one. Forget appears only where the server says
 * it would be allowed, and the server's refusal is shown as it is.
 */

const list = vi.fn();
const forget = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    browser: {
      credentials: {
        list: (...a: unknown[]) => list(...a),
        forget: (...a: unknown[]) => forget(...a),
      },
    },
  },
}));

const OWN: SavedLogin = {
  id: "cred-own",
  agentId: "agent-1",
  label: "LinkedIn — personal",
  siteHost: "linkedin.com",
  scope: "owner",
  lastUsedAt: "2026-10-09T10:00:00.000Z",
  createdAt: "2026-10-01T10:00:00.000Z",
  own: true,
  canForget: true,
};
const SHARED: SavedLogin = {
  id: "cred-shared",
  agentId: "agent-1",
  label: "GitHub — shared",
  siteHost: "github.com",
  scope: "agent",
  lastUsedAt: null,
  createdAt: "2026-10-02T10:00:00.000Z",
  own: false,
  canForget: false,
};

function renderList(props: Parameters<typeof SavedLoginsList>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SavedLoginsList {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  list.mockReset().mockResolvedValue({ logins: [OWN, SHARED] });
  forget.mockReset().mockResolvedValue(undefined);
});

describe("SavedLoginsList", () => {
  it("shows label, host, scope and last use", async () => {
    renderList();

    const own = (await screen.findByText("LinkedIn — personal")).closest("li")!;
    expect(within(own).getByText("linkedin.com")).toBeInTheDocument();
    expect(within(own).getByText("Just you")).toBeInTheDocument();
    expect(within(own).getByText(/^Last used /)).toBeInTheDocument();

    const shared = screen.getByText("GitHub — shared").closest("li")!;
    expect(within(shared).getByText("github.com")).toBeInTheDocument();
    expect(within(shared).getByText("Everyone using this agent")).toBeInTheDocument();
    expect(within(shared).getByText("Not used yet")).toBeInTheDocument();
  });

  it("never draws a username, even if a response carried one", async () => {
    list.mockResolvedValue({
      logins: [{ ...OWN, username: "ada.lovelace@example.com", password: "hunter2" }],
    });
    const { container } = renderList();

    await screen.findByText("LinkedIn — personal");
    expect(container.textContent).not.toContain("ada.lovelace@example.com");
    expect(container.textContent).not.toContain("hunter2");
  });

  it("asks for one agent's logins on that agent's settings", async () => {
    renderList({ agentId: "agent-1" });

    await screen.findByText("LinkedIn — personal");
    expect(list).toHaveBeenCalledWith("agent-1");
  });

  it("offers Forget only where the server would allow it", async () => {
    renderList();

    const own = (await screen.findByText("LinkedIn — personal")).closest("li")!;
    expect(within(own).getByRole("button", { name: "Forget" })).toBeInTheDocument();
    const shared = screen.getByText("GitHub — shared").closest("li")!;
    expect(within(shared).queryByRole("button", { name: "Forget" })).toBeNull();
  });

  it("forgets after a confirmation, and asks for the list again", async () => {
    renderList();

    await userEvent.click(await screen.findByRole("button", { name: "Forget" }));
    await userEvent.click(await screen.findByRole("button", { name: "Forget it" }));

    expect(forget).toHaveBeenCalledWith("cred-own");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  /**
   * Ruling R38: a shared login never runs in anyone's own browser profile, so
   * forgetting it stops the agent signing in as that account. A personal
   * login signs in inside the person's own profile, whose cookies outlive the
   * row — the dialog says so, and where to sign out completely.
   */
  it("says what Forget stops, and what it does not, for each kind of login", async () => {
    list.mockResolvedValue({ logins: [OWN, { ...SHARED, canForget: true }] });
    renderList();

    const own = (await screen.findByText("LinkedIn — personal")).closest("li")!;
    await userEvent.click(within(own).getByRole("button", { name: "Forget" }));
    const personal = await screen.findByRole("alertdialog");
    expect(personal.textContent).toContain(
      "linkedin.com may stay signed in inside your own browser profile until its cookies expire",
    );
    expect(personal.textContent).toContain(
      "To sign out completely, forget your browser sign-ins in Settings → Browser sign-ins (this signs you out of every site)",
    );
    // No per-site removal exists, and none is promised.
    expect(personal.textContent).not.toContain("remove the site");
    await userEvent.click(within(personal).getByRole("button", { name: "Cancel" }));

    const shared = screen.getByText("GitHub — shared").closest("li")!;
    await userEvent.click(within(shared).getByRole("button", { name: "Forget" }));
    const everyone = await screen.findByRole("alertdialog");
    expect(everyone.textContent).toContain(
      "The agent stops signing in to github.com as this account, for everyone",
    );
    expect(everyone.textContent).not.toContain("browser profile");
  });

  it("shows the server's refusal in the dialog", async () => {
    const { ApiError } = await import("@/lib/api-error");
    forget.mockRejectedValue(
      new ApiError(403, "Only a workspace admin, or whoever saved it, can remove a shared login."),
    );
    renderList();

    await userEvent.click(await screen.findByRole("button", { name: "Forget" }));
    await userEvent.click(await screen.findByRole("button", { name: "Forget it" }));

    expect(
      await screen.findByText(
        "Only a workspace admin, or whoever saved it, can remove a shared login.",
      ),
    ).toBeInTheDocument();
  });

  it("says so when there is nothing saved", async () => {
    list.mockResolvedValue({ logins: [] });
    renderList({ empty: "No saved logins for this agent yet." });

    expect(await screen.findByText("No saved logins for this agent yet.")).toBeInTheDocument();
  });

  it("renders nothing when there is nothing saved and nothing to say", async () => {
    list.mockResolvedValue({ logins: [] });
    const { container } = renderList();

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

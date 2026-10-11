import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-error";
import { SignInCard } from "./sign-in-card";

/**
 * The card at a login wall (Task 2.4), and the dialog behind its two Saves.
 *
 * What is not taste here: the Save choices exist only when the wall named its
 * site (R33 — a login cannot be saved for no site); a wall after a saved login
 * says that login did not get past the sign-in; the dialog's footer is the
 * operator's words (R39) and its two-factor line the plan's, exactly; and a password typed into it lives in that dialog's state and
 * nowhere else — not the query client, not a mutation left behind, not the
 * console — and is gone when the dialog closes, saves, or fails.
 */

const save = vi.fn();
const list = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    browser: {
      credentials: {
        save: (...a: unknown[]) => save(...a),
        list: (...a: unknown[]) => list(...a),
      },
    },
  },
}));

const USERNAME = "ada.lovelace@example.com";
const PASSWORD = "hunter2-correct-horse";
const AGENT = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

/** R39 (operator): what the dialog's footer says, with the site substituted. */
const FOOTER =
  "Covan never gives your password to the AI model. It is encrypted, and typed into linkedin.com by the browser provider only.";
const TWO_FACTOR = "Codes, SMS and passkeys still need you — the browser will ask.";

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
let spoken: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  list.mockReset().mockResolvedValue({ logins: [] });
  save.mockReset().mockResolvedValue({
    credential: {
      id: "cred-1",
      scope: "owner",
      siteHost: "linkedin.com",
      label: "linkedin.com — personal",
      replaced: false,
    },
  });
  spoken = LEVELS.map((level) => vi.spyOn(console, level));
});

afterEach(() => {
  // Nothing typed into the dialog reaches any console level, on any path.
  const said = JSON.stringify(spoken.flatMap((spy) => spy.mock.calls));
  expect(said).not.toContain(USERNAME);
  expect(said).not.toContain(PASSWORD);
  vi.restoreAllMocks();
});

function renderCard(over: Partial<Parameters<typeof SignInCard>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    host: "linkedin.com" as string | null,
    carriedSavedLogin: false,
    agentId: AGENT as string | undefined,
    canShare: true,
    onJustThisOnce: vi.fn(),
    onOpenWindow: vi.fn(),
    onSaved: vi.fn(),
    ...over,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <SignInCard {...props} />
    </QueryClientProvider>,
  );
  return { client, props, ...view };
}

/** Everything the query client holds — queries and mutations — as one string. */
function cached(client: QueryClient): string {
  return JSON.stringify({
    queries: client
      .getQueryCache()
      .getAll()
      .map((q) => ({ key: q.queryKey, state: q.state })),
    mutations: client
      .getMutationCache()
      .getAll()
      .map((m) => ({ key: m.options.mutationKey, state: m.state })),
  });
}

async function fillAndSave(label?: string) {
  await userEvent.type(screen.getByLabelText("Username"), USERNAME);
  await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
  if (label !== undefined) {
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), label);
  }
  await userEvent.click(screen.getByRole("button", { name: "Save and continue" }));
}

describe("the three choices", () => {
  it("offers Just this once, Save for me and Save for everyone when the wall named its site", () => {
    renderCard();

    expect(screen.getByText("linkedin.com needs you to sign in.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Just this once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save for me" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save for everyone using this agent" }),
    ).toBeInTheDocument();
  });

  /** R33: a login is saved for a site, and a wall that named none has none to save it for. */
  it("offers only Just this once when the wall named no site", () => {
    renderCard({ host: null });

    expect(screen.getByText("This site needs you to sign in.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Just this once" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("offers only Just this once when there is no agent to save it for", () => {
    renderCard({ agentId: undefined });

    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("takes over for Just this once, and stores nothing", async () => {
    const { props } = renderCard();

    await userEvent.click(screen.getByRole("button", { name: "Just this once" }));
    expect(props.onJustThisOnce).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the new-window fallback", async () => {
    const { props } = renderCard();

    await userEvent.click(screen.getByRole("button", { name: "Open in a new window" }));
    expect(props.onOpenWindow).toHaveBeenCalledTimes(1);
  });

  /**
   * R32: the run carried a saved login and still met the wall. The card says
   * so, and the Saves read as updating it — saving replaces one's own.
   */
  it("says the saved login didn't get past the sign-in, and offers to update it", () => {
    renderCard({ carriedSavedLogin: true });

    // Not "didn't work": a site that asked for a code after a correct
    // password stops at the same wall, and the login was not wrong (#7).
    expect(
      screen.getByText("The saved login for linkedin.com didn't get past the sign-in."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update for me" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update for everyone using this agent" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Just this once" })).toBeInTheDocument();
  });
});

describe("what the card promises", () => {
  /** The first real run: LinkedIn asked again from another address in the same country. */
  it("does not promise the second attempt gets in", () => {
    const { container } = renderCard();
    expect(container.textContent).toMatch(/tie a sign-in to one network address/i);
  });

  it("still says the second attempt is free, because it is", () => {
    const { container } = renderCard();
    expect(container.textContent).toMatch(/no charge for the second attempt/i);
  });

  it("says Covan never receives the password typed at the site", () => {
    const { container } = renderCard();
    expect(container.textContent).toMatch(/covan never receives it/i);
  });
});

describe("the save dialog", () => {
  it("says the footer and the two-factor line, with the site named", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Save for me" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(FOOTER);
    expect(dialog).toHaveTextContent(TWO_FACTOR);
  });

  /**
   * Final review #1 (Critical): a shared login lets colleagues have the agent
   * act as the account, and they can watch what the browser types and what
   * the account shows. The dialog says that, not that they see only a name.
   */
  it("says what everyone using the agent can do with a shared login", async () => {
    renderCard();
    await userEvent.click(
      screen.getByRole("button", { name: "Save for everyone using this agent" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Anyone who uses this agent can have it sign in and act as this account on linkedin.com. " +
        "The list shows them only its name, but they can see what the browser types and what the account shows.",
    );
    expect(dialog.textContent).not.toMatch(/never the username or password/);
  });

  it("masks the password and keeps the browser's own password out of it", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Save for me" }));

    const password = await screen.findByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    // Not Covan's own password: this field is for another site's.
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Username")).toHaveAttribute("autocomplete", "off");
  });

  it("names the login for its site and scope, never with the username", async () => {
    renderCard();
    await userEvent.click(
      screen.getByRole("button", { name: "Save for everyone using this agent" }),
    );

    expect(await screen.findByLabelText("Name")).toHaveValue("linkedin.com — shared");
  });

  it("saves for me, hands back with the site, closes, and keeps nothing", async () => {
    const { client, props } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Save for me" }));
    await screen.findByRole("dialog");

    await fillAndSave();

    expect(save).toHaveBeenCalledWith({
      agentId: AGENT,
      scope: "owner",
      site: "linkedin.com",
      label: "linkedin.com — personal",
      username: USERNAME,
      password: PASSWORD,
    });
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith("linkedin.com", "cred-1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => {
      expect(cached(client)).not.toContain(PASSWORD);
      expect(cached(client)).not.toContain(USERNAME);
    });
  });

  it("saves for everyone with the agent scope", async () => {
    renderCard();
    await userEvent.click(
      screen.getByRole("button", { name: "Save for everyone using this agent" }),
    );
    await screen.findByRole("dialog");

    await fillAndSave();

    expect(save.mock.calls[0][0]).toMatchObject({ scope: "agent", label: "linkedin.com — shared" });
  });

  /**
   * The server's sentence, shown as it is — here R28's: a shared login for
   * the site is somebody else's. The typed values go, and nothing about the
   * failed save is left in the query client either.
   */
  it("shows a refusal, clears what was typed, and keeps nothing", async () => {
    save.mockRejectedValue(
      new ApiError(
        409,
        "A shared login for linkedin.com already exists. Ask a workspace admin, or whoever saved it, to remove it first.",
      ),
    );
    const { client, props } = renderCard({ carriedSavedLogin: true });
    await userEvent.click(
      screen.getByRole("button", { name: "Update for everyone using this agent" }),
    );
    await screen.findByRole("dialog");

    await fillAndSave();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A shared login for linkedin.com already exists. Ask a workspace admin, or whoever saved it, to remove it first.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(props.onSaved).not.toHaveBeenCalled();
    await waitFor(() => expect(cached(client)).not.toContain(PASSWORD));
    expect(cached(client)).not.toContain(USERNAME);
  });

  it("forgets what was typed when it is closed", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Save for me" }));
    await userEvent.type(await screen.findByLabelText("Username"), USERNAME);
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Save for me" }));
    expect(await screen.findByLabelText("Username")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(save).not.toHaveBeenCalled();
  });

  /**
   * R37: the host the wall reported is a page's word as much as the model's,
   * and a wall on a subdomain would file the login under the subdomain. So
   * the site is shown, editable, and what is saved is what the person
   * confirmed — and the hand-back names what the server saved.
   */
  describe("the Site field (R37)", () => {
    const CHECK =
      "Check this is the site you mean — the login will only ever be typed on this site and its subdomains.";

    it("shows the wall's host in an editable Site field, with the line that says why", async () => {
      renderCard({ host: "accounts.linkedin.com" });
      await userEvent.click(screen.getByRole("button", { name: "Save for me" }));

      const site = await screen.findByLabelText("Site");
      expect(site).toHaveValue("accounts.linkedin.com");
      expect(site).not.toHaveAttribute("readonly");
      expect(screen.getByRole("dialog")).toHaveTextContent(CHECK);
    });

    it("saves for the site the person confirmed, and hands back with the one the server saved", async () => {
      const { props } = renderCard({ host: "accounts.linkedin.com" });
      await userEvent.click(screen.getByRole("button", { name: "Save for me" }));
      await userEvent.clear(await screen.findByLabelText("Site"));
      await userEvent.type(screen.getByLabelText("Site"), "linkedin.com");

      await fillAndSave();

      expect(save.mock.calls[0][0]).toMatchObject({ site: "linkedin.com" });
      await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith("linkedin.com", "cred-1"));
    });

    it("cannot be saved with no site", async () => {
      renderCard();
      await userEvent.click(screen.getByRole("button", { name: "Save for me" }));
      await userEvent.clear(await screen.findByLabelText("Site"));
      await userEvent.type(screen.getByLabelText("Username"), USERNAME);
      await userEvent.type(screen.getByLabelText("Password"), PASSWORD);

      expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    });
  });

  /**
   * "Update" only when the save really replaces the caller's own login of
   * that scope for this site on this agent — otherwise it makes a second row,
   * and the title says Save.
   */
  it("titles an update as one when it replaces the caller's own login", async () => {
    list.mockResolvedValue({
      logins: [
        {
          id: "cred-own",
          agentId: AGENT,
          label: "LinkedIn — personal",
          siteHost: "linkedin.com",
          scope: "owner",
          lastUsedAt: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          own: true,
          canForget: true,
        },
      ],
    });
    renderCard({ carriedSavedLogin: true });
    await userEvent.click(screen.getByRole("button", { name: "Update for me" }));

    expect(
      await screen.findByRole("heading", { name: "Update the saved login for linkedin.com" }),
    ).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith(AGENT);
  });

  it("titles it a save when it would make a second login, not replace one", async () => {
    // The run carried the caller's PERSONAL login; "for everyone" adds a shared one.
    list.mockResolvedValue({
      logins: [
        {
          id: "cred-own",
          agentId: AGENT,
          label: "LinkedIn — personal",
          siteHost: "linkedin.com",
          scope: "owner",
          lastUsedAt: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          own: true,
          canForget: true,
        },
      ],
    });
    renderCard({ carriedSavedLogin: true });
    await userEvent.click(
      screen.getByRole("button", { name: "Update for everyone using this agent" }),
    );

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(
      await screen.findByRole("heading", { name: "Save a login for linkedin.com, for everyone" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Update/ })).toBeNull();
  });
});

describe("who may save for everyone (R34)", () => {
  /** A viewer may use the agent and save a login for themself; a shared one is a member's. */
  it("offers a viewer no 'for everyone' choice", () => {
    renderCard({ canShare: false });

    expect(screen.getByRole("button", { name: "Save for me" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /for everyone/i })).toBeNull();
  });

  it("offers a viewer no 'for everyone' update either", () => {
    renderCard({ canShare: false, carriedSavedLogin: true });

    expect(screen.getByRole("button", { name: "Update for me" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /for everyone/i })).toBeNull();
  });
});

describe("while a take-over is under way", () => {
  it("disables every choice", () => {
    renderCard({ opening: true });

    expect(screen.getByRole("button", { name: "Just this once" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save for me" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save for everyone using this agent" }),
    ).toBeDisabled();
  });
});

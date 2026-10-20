import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateRoutineDialog } from "./create-routine-dialog";

const { draft, channelsList, me, createRoutine, eventCatalog } = vi.hoisted(() => ({
  draft: vi.fn(),
  eventCatalog: vi.fn(),
  channelsList: vi.fn(),
  me: vi.fn(),
  createRoutine: vi.fn(),
}));

// The event picker links to Integrations for an app that is not connected —
// a router <Link>, which needs a context this test has no reason to build.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    me,
    routines: { draft, create: createRoutine, eventCatalog },
    deliveryChannels: { list: channelsList, create: vi.fn(), remove: vi.fn() },
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// The dialog reads this agent's document count off the agents store to decide
// which templates are offered — a plain context hook, so a component under
// test that is not wrapped in AgentsProvider needs it mocked rather than
// provided.
vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({ agents: [] }),
}));

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CreateRoutineDialog agentId="a1" />
    </QueryClientProvider>,
  );
}

describe("CreateRoutineDialog", () => {
  beforeEach(() => {
    draft.mockReset();
    channelsList.mockReset();
    me.mockReset();
    createRoutine.mockReset();
    createRoutine.mockResolvedValue({});
    eventCatalog.mockReset();
    eventCatalog.mockResolvedValue([]);
    me.mockResolvedValue({
      user: { id: "u1", name: "Ada", email: "ada@example.com", avatarUrl: null },
      workspace: {
        id: "w1",
        name: "Acme",
        slug: "acme",
        defaultModel: null,
        gapReportEnabled: true,
      },
      members: [
        { id: "u1", name: "Ada", email: "ada@example.com", role: "admin", avatarUrl: null },
      ],
    });
  });

  it("asks for an address in place of the channel picker when there is none", async () => {
    channelsList.mockResolvedValue([]);
    me.mockResolvedValue({
      user: { id: "u1", email: "me@example.com" },
      workspace: {},
      members: [{ id: "u1", role: "admin" }],
    });
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.click(screen.getByRole("button", { name: /set it up myself/i }));

    const field = await screen.findByLabelText(/deliver to/i);
    // Pre-filled with the signed-in account's own address.
    expect(field).toHaveValue("me@example.com");
    expect(screen.queryByText(/open Settings/)).not.toBeInTheDocument();
  });

  it("disables Create once the pre-filled address is cleared, with no channel to fall back to", async () => {
    channelsList.mockResolvedValue([]);
    me.mockResolvedValue({
      user: { id: "u1", email: "me@example.com" },
      workspace: {},
      members: [{ id: "u1", role: "admin" }],
    });
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.click(screen.getByRole("button", { name: /set it up myself/i }));
    await user.type(await screen.findByLabelText(/name/i), "First week");
    await user.type(screen.getByLabelText(/instruction/i), "say something");
    await user.clear(screen.getByLabelText(/deliver to/i));

    expect(screen.getByRole("button", { name: /^Create routine$/i })).toBeDisabled();
  });

  it("sends an address rather than a channel id when there is no channel", async () => {
    channelsList.mockResolvedValue([]);
    me.mockResolvedValue({
      user: { id: "u1", email: "me@example.com" },
      workspace: {},
      members: [{ id: "u1", role: "admin" }],
    });
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.click(screen.getByRole("button", { name: /set it up myself/i }));
    await user.type(await screen.findByLabelText(/name/i), "First week");
    await user.type(screen.getByLabelText(/instruction/i), "say something");
    await user.click(screen.getByRole("button", { name: /^Create routine$/i }));

    expect(createRoutine).toHaveBeenCalledTimes(1);
    const payload = createRoutine.mock.calls[0][0];
    expect(payload.deliveryEmail).toBe("me@example.com");
    expect(payload).not.toHaveProperty("deliveryChannelId");
  });

  it("sends a channel id rather than an address when channels already exist", async () => {
    channelsList.mockResolvedValue([
      { id: "c1", kind: "email", label: "m…a@x.com", createdAt: 0, confirmed: true },
    ]);
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.click(screen.getByRole("button", { name: /set it up myself/i }));
    await user.type(await screen.findByLabelText(/name/i), "First week");
    await user.type(screen.getByLabelText(/instruction/i), "say something");
    await user.click(screen.getByRole("button", { name: /^Create routine$/i }));

    expect(createRoutine).toHaveBeenCalledTimes(1);
    const payload = createRoutine.mock.calls[0][0];
    expect(payload.deliveryChannelId).toBe("c1");
    expect(payload).not.toHaveProperty("deliveryEmail");
  });

  // A draft the parser cannot read must not trap the user on step one retrying
  // prose; the form is always reachable.
  /**
   * covan-cloud#305. A list that has not answered is not an empty one: the
   * address box used to render while channels loaded, then turn into a
   * pre-selected Select, dropping what was typed and enabling Create for a
   * channel nobody picked.
   */
  it("offers neither the address nor a channel until the channel list answers", async () => {
    let resolveChannels!: (value: unknown) => void;
    channelsList.mockImplementation(() => new Promise((resolve) => (resolveChannels = resolve)));
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.click(screen.getByRole("button", { name: /set it up myself/i }));
    await user.type(await screen.findByLabelText(/name/i), "First week");
    await user.type(screen.getByLabelText(/instruction/i), "say something");

    expect(screen.queryByPlaceholderText("you@company.com")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Create routine$/i })).toBeDisabled();

    resolveChannels([{ id: "c1", kind: "email", label: "m…a@x.com", createdAt: 0 }]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Create routine$/i })).not.toBeDisabled(),
    );
    expect(screen.queryByPlaceholderText("you@company.com")).not.toBeInTheDocument();
  });

  /**
   * covan-cloud#310. The schedule refusal lands on the schedule; the address
   * refusal used to be a toast, so the one field a new account must fill
   * reported its own rejection somewhere else.
   */
  it("puts an address the API refuses under the address, not in a toast", async () => {
    channelsList.mockResolvedValue([]);
    const { ApiError } = await import("@/lib/api-client");
    createRoutine.mockRejectedValue(
      new (ApiError as unknown as new (s: number, m: string) => Error)(400, "not an email address"),
    );
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.click(screen.getByRole("button", { name: /set it up myself/i }));
    await user.type(await screen.findByLabelText(/name/i), "First week");
    await user.type(screen.getByLabelText(/instruction/i), "say something");
    const field = screen.getByLabelText(/deliver to/i);
    await user.clear(field);
    await user.type(field, "me@nowhere");
    await user.click(screen.getByRole("button", { name: /^Create routine$/i }));

    expect(await screen.findByText(/doesn.t look like an email address/i)).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");

    // Editing the field takes the refusal back down.
    await user.type(field, ".com");
    expect(screen.queryByText(/doesn.t look like an email address/i)).not.toBeInTheDocument();
  });

  it("still toasts a refusal that belongs to no field", async () => {
    channelsList.mockResolvedValue([]);
    const { ApiError } = await import("@/lib/api-client");
    createRoutine.mockRejectedValue(
      new (ApiError as unknown as new (s: number, m: string) => Error)(
        500,
        "something else went wrong",
      ),
    );
    const { toast } = await import("sonner");
    const toastError = vi.spyOn(toast, "error");
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.click(screen.getByRole("button", { name: /set it up myself/i }));
    await user.type(await screen.findByLabelText(/name/i), "First week");
    await user.type(screen.getByLabelText(/instruction/i), "say something");
    const field = screen.getByLabelText(/deliver to/i);
    await user.clear(field);
    await user.type(field, "me@example.com");
    await user.click(screen.getByRole("button", { name: /^Create routine$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("something else went wrong"));
    expect(screen.queryByText(/doesn.t look like an email address/i)).not.toBeInTheDocument();
    toastError.mockRestore();
  });

  it("falls through to the editable form when the draft cannot be read", async () => {
    channelsList.mockResolvedValue([
      { id: "c1", kind: "email", label: "m…a@x.com", createdAt: 0, confirmed: true },
    ]);
    draft.mockRejectedValue(Object.assign(new Error("could not read that"), { status: 422 }));
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.type(screen.getByRole("textbox"), "watch something");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByLabelText(/Name/i)).toBeInTheDocument();
  });

  it("warns that the first run of a source-watching routine is silent", async () => {
    channelsList.mockResolvedValue([
      { id: "c1", kind: "email", label: "m…a@x.com", createdAt: 0, confirmed: true },
    ]);
    draft.mockResolvedValue({
      name: "r/SaaS",
      sourceKind: "rss",
      sourceUrl: "https://example.com/feed.xml",
      cron: "0 * * * *",
      instruction: "summarise",
      channelKind: "email",
      timezone: "UTC",
    });
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.type(screen.getByRole("textbox"), "watch r/saas");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByText(/first run just takes a snapshot/i)).toBeInTheDocument();
  });

  /**
   * Item 4 of the adjudication pass. A `workspace` source has no cursor and
   * no diff (coverage-source.ts reads a rolling seven-day window and reports
   * on it immediately), so the snapshot sentence above is false for it: there
   * is no "next change" to wait for. This drives the actual `gap-report`
   * template through the actual dialog, like the two tests above it do for
   * this same template, rather than asserting on the guard in isolation.
   */
  it("tells the truth about the gap-report template's first run instead", async () => {
    channelsList.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CreateRoutineDialog agentId="a1" openTemplate="gap-report" />
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue("Coverage gaps")).toBeInTheDocument();
    expect(screen.getByText(/first run already covers the past week/i)).toBeInTheDocument();
    expect(screen.queryByText(/first run just takes a snapshot/i)).not.toBeInTheDocument();
  });
});

describe("opened from a link", () => {
  it("opens on the named template, already filled in", async () => {
    channelsList.mockResolvedValue([{ id: "c1", kind: "email", label: "me@example.com" }]);
    const onConsumed = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CreateRoutineDialog
          agentId="a1"
          openTemplate="first-week"
          onTemplateConsumed={onConsumed}
        />
      </QueryClientProvider>,
    );

    // Straight to step 2, with the template's own name in the field.
    expect(await screen.findByDisplayValue("First week")).toBeInTheDocument();
    // And the request is taken back out of the URL exactly once.
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  /**
   * A2. `applyTemplate` used to compute `channelId` against `channels`
   * directly, which is `[]` at this exact moment — `useDeliveryChannels` has
   * not resolved yet on a deep-linked open — so `channelId` landed `""` and
   * nothing re-seeded it once the real list arrived a beat later. Create
   * stayed disabled until the person opened the dropdown and picked the only
   * item by hand. `resolvedChannelId` fixes this by re-resolving the wanted
   * channel kind against the live list on every render; this is the
   * regression test for it.
   *
   * The next test below covers `gap-report` with zero channels and the email
   * path. This one gives it one channel instead, which is the only way to
   * reach the Select this fix is about.
   */
  it("selects the one channel immediately for a template opened from a link", async () => {
    channelsList.mockResolvedValue([{ id: "c1", kind: "email", label: "me@example.com" }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CreateRoutineDialog agentId="a1" openTemplate="gap-report" />
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue("Coverage gaps")).toBeInTheDocument();
    // `channels` resolves on its own tick, a beat after the name field above
    // — the exact gap this fix closes — so this waits for it rather than
    // asserting the instant the name appears.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Create routine$/i })).not.toBeDisabled(),
    );
  });

  /**
   * Task 17's blocker (a). `canSave`'s source check used to fall through to
   * the url branch for every `sourceKind` it did not name explicitly, so a
   * `workspace` routine — which has no url field on screen at all — landed on
   * `sourceUrl.trim() !== ""` and `gap-report`'s `sourceUrl: null` left Create
   * permanently disabled. This drives the actual template through the actual
   * dialog rather than asserting on `canSave` in isolation, so a regression
   * in either the template's shape or the check itself fails here.
   */
  it("enables Create for the gap-report template, whose workspace source needs no url", async () => {
    channelsList.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CreateRoutineDialog agentId="a1" openTemplate="gap-report" />
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue("Coverage gaps")).toBeInTheDocument();
    // `me` resolves a beat after mount, and the pre-filled address derives
    // from it live rather than from a snapshot `applyTemplate` took (see
    // `resolvedDeliveryEmail`'s own comment) — so wait for it rather than
    // asserting before it has had a chance to land.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Create routine$/i })).not.toBeDisabled(),
    );
  });

  /**
   * Review Focus 3. Somebody edits the URL, or a template is renamed after a
   * link was shared. The dialog opens on step 1 — the normal thing — rather
   * than crashing or landing on an empty step 2.
   */
  // `weekly-digest` is here because it used to exist: links to it are out in
  // the world, and it was retired with the URL field (covan#241).
  it.each(["no-such-template", "weekly-digest"])("opens normally for %s", async (id) => {
    channelsList.mockResolvedValue([]);
    const onConsumed = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CreateRoutineDialog agentId="a1" openTemplate={id} onTemplateConsumed={onConsumed} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/or start from one of these/)).toBeInTheDocument();
    // Still consumed: the parameter is a request, and leaving it in the URL
    // would retry this on every reopen.
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it("does nothing special with no template named", async () => {
    channelsList.mockResolvedValue([]);
    const onConsumed = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CreateRoutineDialog agentId="a1" onTemplateConsumed={onConsumed} />
      </QueryClientProvider>,
    );
    expect(onConsumed).not.toHaveBeenCalled();
  });

  /**
   * Finding 2 of the fix round. A templated deep link is exactly the cold
   * load the task's own spec describes: `openTemplate`'s effect runs on
   * mount and moves straight to step 2, often before `me` has resolved. The
   * field must still end up filled once `me` does — not stuck with whatever
   * it saw at the moment step 2 first rendered.
   */
  it("pre-fills the address once `me` resolves, even though step 2 rendered first", async () => {
    channelsList.mockResolvedValue([]);
    let resolveMe!: (value: unknown) => void;
    me.mockImplementation(() => new Promise((resolve) => (resolveMe = resolve)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <CreateRoutineDialog agentId="a1" openTemplate="first-week" />
      </QueryClientProvider>,
    );

    // Step 2 is already showing, with `me` still unresolved.
    const field = await screen.findByLabelText(/deliver to/i);
    expect(field).toHaveValue("");

    resolveMe({
      user: { id: "u1", email: "me@example.com" },
      workspace: {},
      members: [{ id: "u1", role: "admin" }],
    });

    await waitFor(() => expect(field).toHaveValue("me@example.com"));
  });
});

describe("CreateRoutineDialog, starting on an app event", () => {
  const CATALOG = [
    {
      type: "gmail.new_message",
      provider: "composio",
      app: "Gmail",
      label: "New mail",
      description: "A message arrives in the inbox.",
      fields: [{ key: "query", label: "Only mail matching", kind: "text", optional: true }],
      requires: { kind: "composio", toolkit: "gmail" },
      connected: true,
    },
    {
      type: "hubspot.contact_created",
      provider: "composio",
      app: "HubSpot",
      label: "New contact",
      description: "A contact is created.",
      fields: [],
      requires: { kind: "composio", toolkit: "hubspot" },
      connected: false,
    },
  ];

  beforeEach(() => {
    createRoutine.mockReset();
    createRoutine.mockResolvedValue({});
    me.mockResolvedValue({ user: { id: "u1" }, workspace: {}, members: [] });
    channelsList.mockResolvedValue([
      { id: "c1", kind: "email", label: "m…a@x.com", createdAt: 0, confirmed: true },
    ]);
    eventCatalog.mockReset();
    eventCatalog.mockResolvedValue(CATALOG);
  });

  async function openOnEvent() {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.click(screen.getByRole("button", { name: /set it up myself/i }));
    await user.type(await screen.findByLabelText(/name/i), "Inbox");
    await user.type(screen.getByLabelText(/instruction/i), "tell me what matters");
    await user.click(screen.getByLabelText(/^starts$/i));
    await user.click(
      await screen.findByRole("option", { name: /when something happens in an app/i }),
    );
    return user;
  }

  it("asks which app and what happens in it, and not for a schedule", async () => {
    const user = await openOnEvent();

    await user.click(await screen.findByLabelText(/^app$/i));
    await user.click(await screen.findByRole("option", { name: "Gmail" }));

    expect(await screen.findByText("A message arrives in the inbox.")).toBeInTheDocument();
    expect(screen.getByLabelText(/only mail matching/i)).toBeInTheDocument();
    // An event routine is never due; offering a schedule would promise a run.
    expect(screen.queryByText(/^Repeats$/i)).not.toBeInTheDocument();
  });

  it("sends the event it waits for with the routine", async () => {
    const user = await openOnEvent();
    expect(screen.getByRole("button", { name: /^Create routine$/i })).toBeDisabled();

    await user.click(await screen.findByLabelText(/^app$/i));
    await user.click(await screen.findByRole("option", { name: "Gmail" }));
    await user.type(screen.getByLabelText(/only mail matching/i), "from:boss");
    await user.click(screen.getByRole("button", { name: /^Create routine$/i }));

    const payload = createRoutine.mock.calls[0][0];
    expect(payload.triggerKind).toBe("event");
    expect(payload.event).toEqual({ type: "gmail.new_message", config: { query: "from:boss" } });
  });

  it("offers to connect an app that is not connected, and will not create until it is", async () => {
    const user = await openOnEvent();

    await user.click(await screen.findByLabelText(/^app$/i));
    await user.click(await screen.findByRole("option", { name: "HubSpot" }));

    expect(await screen.findByText(/HubSpot is not connected yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect hubspot/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Create routine$/i })).toBeDisabled();
  });
});

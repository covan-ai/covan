import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateRoutineDialog } from "./create-routine-dialog";

const { draft, channelsList, me, createRoutine } = vi.hoisted(() => ({
  draft: vi.fn(),
  channelsList: vi.fn(),
  me: vi.fn(),
  createRoutine: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    me,
    routines: { draft, create: createRoutine },
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
    channelsList.mockResolvedValue([{ id: "c1", kind: "email", label: "m…a@x.com", createdAt: 0 }]);
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
  it("falls through to the editable form when the draft cannot be read", async () => {
    channelsList.mockResolvedValue([{ id: "c1", kind: "email", label: "m…a@x.com", createdAt: 0 }]);
    draft.mockRejectedValue(Object.assign(new Error("could not read that"), { status: 422 }));
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.type(screen.getByRole("textbox"), "watch something");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByLabelText(/Name/i)).toBeInTheDocument();
  });

  it("warns that the first run of a source-watching routine is silent", async () => {
    channelsList.mockResolvedValue([{ id: "c1", kind: "email", label: "m…a@x.com", createdAt: 0 }]);
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
          openTemplate="weekly-digest"
          onTemplateConsumed={onConsumed}
        />
      </QueryClientProvider>,
    );

    // Straight to step 2, with the template's own name in the field.
    expect(await screen.findByDisplayValue("Weekly digest")).toBeInTheDocument();
    // And the request is taken back out of the URL exactly once.
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  /**
   * Review Focus 3. Somebody edits the URL, or a template is renamed after a
   * link was shared. The dialog opens on step 1 — the normal thing — rather
   * than crashing or landing on an empty step 2.
   */
  it("opens normally for a template id that does not exist", async () => {
    channelsList.mockResolvedValue([]);
    const onConsumed = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CreateRoutineDialog
          agentId="a1"
          openTemplate="no-such-template"
          onTemplateConsumed={onConsumed}
        />
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
        <CreateRoutineDialog agentId="a1" openTemplate="weekly-digest" />
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

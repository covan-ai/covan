import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateRoutineDialog } from "./create-routine-dialog";

// The empty-channel branch links to Settings with a TanStack Router <Link>,
// which needs a router context this test has no reason to build. Same stub as
// routines-list.test.tsx.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

const { draft, channelsList } = vi.hoisted(() => ({
  draft: vi.fn(),
  channelsList: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    routines: { draft, create: vi.fn() },
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
  });

  it("sends the user to Settings when they have no delivery channel", async () => {
    channelsList.mockResolvedValue([]);
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: /new routine/i }));
    await user.click(screen.getByRole("button", { name: /set it up myself/i }));

    expect(
      await screen.findByText(/Add a delivery channel in Settings first/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Create routine$/i })).toBeDisabled();
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

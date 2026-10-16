import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OutOfCreditsNote } from "./out-of-credits";
import { adminsToAsk } from "@/lib/admins-to-ask";

const me = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { me: () => me(), support: { quota: vi.fn() } },
}));

const members = [
  { id: "u-admin", name: "Ada", email: "ada@acme.com", role: "admin" },
  { id: "u-member", name: "Bob", email: "bob@acme.com", role: "member" },
];

function renderNote(props: { canRetry: boolean; onRetry?: () => void }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OutOfCreditsNote {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("adminsToAsk", () => {
  it("names the admins, never the caller", () => {
    expect(adminsToAsk(members, "u-member")).toBe("Ada");
    expect(adminsToAsk(members, "u-admin")).toBeNull();
  });

  it("joins several the way a sentence would", () => {
    const three = [
      { id: "a", name: "Ada", email: null, role: "admin" },
      { id: "b", name: null, email: "bea@acme.com", role: "admin" },
      { id: "c", name: "Cy", email: null, role: "admin" },
    ];
    expect(adminsToAsk(three.slice(0, 2), "x")).toBe("Ada or bea@acme.com");
    expect(adminsToAsk(three, "x")).toBe("Ada, bea@acme.com or Cy");
  });
});

describe("the note where the reply would have been", () => {
  it("tells a member which admin to ask, and waits to offer Try again", async () => {
    me.mockResolvedValue({ user: { id: "u-member" }, members });
    const onRetry = vi.fn();
    renderNote({ canRetry: false, onRetry });

    expect(await screen.findByText(/ask ada, an admin of this workspace/i)).toBeInTheDocument();
    expect(
      screen.getByText(/out of credits, so this message has no reply yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeDisabled();
    // The message form is a click away for a member, not in their face.
    expect(screen.queryByLabelText(/what do you need/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /or message covan/i }));
    expect(screen.getByLabelText(/what do you need/i)).toBeInTheDocument();
  });

  it("gives an admin the form to ask for credits", async () => {
    me.mockResolvedValue({ user: { id: "u-admin" }, members });
    renderNote({ canRetry: false });

    expect(await screen.findByText(/top-ups are handled by hand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/what do you need/i)).toBeInTheDocument();
  });

  it("offers Try again once credits are back", async () => {
    me.mockResolvedValue({ user: { id: "u-member" }, members });
    const onRetry = vi.fn();
    renderNote({ canRetry: true, onRetry });

    expect(screen.getByText(/credits are back/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("survives a me without its member list", async () => {
    me.mockResolvedValue({ user: { id: "u-member" } });
    renderNote({ canRetry: false });

    expect(await screen.findByText(/ask an admin of this workspace/i)).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupabaseAccount, ToolConnection } from "@/lib/connections-api";
import { SupabaseAccountCard } from "./supabase-account-card";

/**
 * The second road to a database, as a person walks it: paste a token, tick a
 * project.
 *
 * Two claims here are the ones worth keeping. An account-wide token is an
 * admin's to give, so a member is told whose door to knock on rather than
 * shown a field that answers 403. And the token never comes back — the card
 * has four characters of it and there is nowhere else it could get more.
 */
const { connect, addProjects, disconnect, removeProject } = vi.hoisted(() => ({
  connect: { mutate: vi.fn(), isPending: false },
  addProjects: { mutate: vi.fn(), isPending: false },
  disconnect: { mutate: vi.fn(), isPending: false },
  removeProject: { mutate: vi.fn(), isPending: false },
}));

let account: SupabaseAccount | null = null;
let role = "admin";
const listed = [
  { ref: "abcdefghijklmnop", name: "covan-prod", region: "eu-central-1", status: "ACTIVE_HEALTHY" },
  {
    ref: "qrstuvwxyzabcdef",
    name: "covan-staging",
    region: "eu-central-1",
    status: "ACTIVE_HEALTHY",
  },
];

// Mocked whole rather than partially, for the reason connection-card.test.tsx
// gives: the real module constructs a Supabase client at import time, which
// needs an origin no unit test has.
vi.mock("@/lib/api-client", () => ({
  api: { me: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    // `me` is the only thing this card reads directly rather than through a
    // hook of its own, and it reads it for one boolean.
    useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
      data:
        queryKey[0] === "me"
          ? { user: { id: "user-1" }, members: [{ id: "user-1", role }] }
          : undefined,
    }),
  };
});

vi.mock("@/hooks/use-connections", () => ({
  useSupabaseAccount: () => ({ data: { account }, isLoading: false }),
  useSupabaseProjects: () => ({ data: { projects: listed }, isLoading: false }),
  useConnectSupabaseAccount: () => connect,
  useAddSupabaseProjects: () => addProjects,
  useDisconnectSupabaseAccount: () => disconnect,
  useRemoveToolConnection: () => removeProject,
}));

const CONNECTED: SupabaseAccount = {
  id: "acct-1",
  tokenHint: "sbp…ab12",
  connectedBy: "user-1",
  createdAt: 1,
};

function project(over: Partial<ToolConnection> = {}): ToolConnection {
  return {
    id: "conn-1",
    label: "covan-prod",
    transport: "supabase",
    baseUrl: "https://api.supabase.com",
    allowedMethods: ["GET"],
    summary: null,
    rpc: null,
    accountId: "acct-1",
    projectRef: "abcdefghijklmnop",
    createdAt: 1,
    ...over,
  };
}

beforeEach(() => {
  account = null;
  role = "admin";
  connect.mutate.mockReset();
  addProjects.mutate.mockReset();
  disconnect.mutate.mockReset();
  removeProject.mutate.mockReset();
});

describe("with nothing connected", () => {
  it("takes a token from an admin", async () => {
    render(<SupabaseAccountCard connections={[]} />);
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));
    await userEvent.type(screen.getByLabelText(/access token/i), "sbp_abcdefghij1234ab12");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(connect.mutate).toHaveBeenCalledWith(
      { token: "sbp_abcdefghij1234ab12" },
      expect.anything(),
    );
  });

  it("tells a member whose door to knock on instead of showing a field", () => {
    role = "member";
    render(<SupabaseAccountCard connections={[]} />);

    expect(screen.queryByLabelText(/access token/i)).toBeNull();
    expect(screen.getByText(/admin/i)).toBeInTheDocument();
  });
});

describe("with an account connected", () => {
  it("shows four characters of the token and no way to see more", () => {
    account = CONNECTED;
    render(<SupabaseAccountCard connections={[project()]} />);

    expect(screen.getByText("sbp…ab12")).toBeInTheDocument();
    expect(screen.getByText("covan-prod")).toBeInTheDocument();
  });

  it("connects the projects a person ticked", async () => {
    account = CONNECTED;
    render(<SupabaseAccountCard connections={[]} />);

    await userEvent.click(screen.getByRole("button", { name: /add a project/i }));
    await userEvent.click(screen.getByRole("checkbox", { name: /covan-staging/i }));
    await userEvent.click(screen.getByRole("button", { name: /connect 1 project/i }));

    expect(addProjects.mutate).toHaveBeenCalledWith(
      { refs: ["qrstuvwxyzabcdef"] },
      expect.anything(),
    );
  });

  it("does not offer a project that is already connected", async () => {
    account = CONNECTED;
    render(<SupabaseAccountCard connections={[project()]} />);

    await userEvent.click(screen.getByRole("button", { name: /add a project/i }));

    expect(screen.queryByRole("checkbox", { name: /covan-prod/i })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /covan-staging/i })).toBeInTheDocument();
  });

  // Disconnecting the account takes every project with it (0061's cascade), so
  // there has to be a way to drop one without dropping all of them.
  it("removes one project without disconnecting the account", async () => {
    account = CONNECTED;
    render(<SupabaseAccountCard connections={[project()]} />);

    await userEvent.click(screen.getByRole("button", { name: /remove/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    expect(removeProject.mutate).toHaveBeenCalledWith("conn-1", expect.anything());
    expect(disconnect.mutate).not.toHaveBeenCalled();
  });

  it("keeps disconnecting to an admin", () => {
    account = CONNECTED;
    role = "member";
    render(<SupabaseAccountCard connections={[project()]} />);

    expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
  });
});

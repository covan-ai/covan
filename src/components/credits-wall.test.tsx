import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me } from "@/lib/api-client";

import { CreditsWall } from "./credits-wall";

// A real `QueryClient` around the component, with only `@/lib/api-client`
// mocked — the pattern `create-routine-dialog.test.tsx` set for a component
// that reads through `useQuery` and writes through `useMutation`.
const { me, supportQuota } = vi.hoisted(() => ({ me: vi.fn(), supportQuota: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
  api: { me, support: { quota: supportQuota } },
}));

function meWith(role: "admin" | "member" | "viewer"): Me {
  return {
    user: { id: "u1", name: "Ada", email: "ada@example.com", avatarUrl: null },
    workspace: { id: "w1", name: "Acme", slug: "acme", defaultModel: null },
    members: [{ id: "u1", name: "Ada", email: "ada@example.com", role, avatarUrl: null }],
    onboarding: {
      completed: true,
      lastStep: null,
      agentId: null,
      sessionId: null,
      answers: {
        assistantName: null,
        assistantEmoji: null,
        assistantRole: null,
        tools: null,
        purpose: null,
        mode: null,
      },
    },
  };
}

function renderWall(role: "admin" | "member" | "viewer") {
  me.mockResolvedValue(meWith(role));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CreditsWall />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("CreditsWall", () => {
  it("tells an admin that top-ups are by hand for now, and gives them the form", async () => {
    renderWall("admin");
    expect(await screen.findByText(/Top-ups are handled by hand/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "What do you need?" })).toBeInTheDocument();
  });

  it("gives a member the same form, and points them at an admin too", async () => {
    renderWall("member");
    expect(await screen.findByText(/ask an admin of this workspace/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "What do you need?" })).toBeInTheDocument();
  });

  it("never offers a key field — the model provider is Covan's", async () => {
    renderWall("admin");
    await screen.findByText(/Top-ups are handled by hand/);
    expect(screen.queryByText(/OpenAI key/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/key/i)).not.toBeInTheDocument();
  });

  it("still names self-hosting as the thorough option", async () => {
    renderWall("viewer");
    expect(await screen.findByText(/Running it yourself/)).toBeInTheDocument();
  });
});

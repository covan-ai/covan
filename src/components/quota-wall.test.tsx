import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me, ProviderKeyHints } from "@/lib/api-client";

import { QuotaWall } from "./quota-wall";

// `QuotaWall` reads `["me"]` and `["provider-keys"]` through real `useQuery`,
// and `ProviderKeyForm`/`QuotaSupportForm` underneath it write through real
// `useMutation`. Mocking `useQuery` itself (the way `usage-section.test.tsx`
// does for a component with a single, synchronous read) would mean re-building
// react-query's loading/success machinery by hand for three hooks at once.
// `create-routine-dialog.test.tsx` already solved this the same way this
// component needs: a real `QueryClient` wrapping the component, with only
// `@/lib/api-client` mocked. That is followed here instead of inventing a
// second pattern.
const { me, providerKeysGet, providerKeysSet, providerKeysClear, supportQuota } = vi.hoisted(
  () => ({
    me: vi.fn(),
    providerKeysGet: vi.fn(),
    providerKeysSet: vi.fn(),
    providerKeysClear: vi.fn(),
    supportQuota: vi.fn(),
  }),
);

vi.mock("@/lib/api-client", () => ({
  api: {
    me,
    providerKeys: { get: providerKeysGet, set: providerKeysSet, clear: providerKeysClear },
    support: { quota: supportQuota },
  },
}));

function meWith(role: "admin" | "member" | "viewer"): Me {
  return {
    user: { id: "u1", name: "Ada", email: "ada@example.com", avatarUrl: null },
    workspace: { id: "w1", name: "Acme", slug: "acme", defaultModel: null },
    members: [{ id: "u1", name: "Ada", email: "ada@example.com", role, avatarUrl: null }],
    onboarding: {
      completed: true,
      answers: { role: null, useCase: null, teamSize: null, referralSource: null },
    },
  };
}

function hintsWith(overrides: Partial<ProviderKeyHints> = {}): ProviderKeyHints {
  return { configured: true, openai: null, anthropic: null, updatedAt: null, ...overrides };
}

function renderWall({
  role,
  configured,
  hints,
}: {
  role: "admin" | "member" | "viewer";
  configured: boolean;
  hints?: Partial<Pick<ProviderKeyHints, "openai" | "anthropic">>;
}) {
  me.mockResolvedValue(meWith(role));
  providerKeysGet.mockResolvedValue(hintsWith({ configured, ...hints }));

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QuotaWall />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("QuotaWall", () => {
  it("offers an admin the key field and the form", async () => {
    renderWall({ role: "admin", configured: true });

    expect(await screen.findByLabelText(/OpenAI key/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  it("tells a member to ask their admin, and still offers the form", async () => {
    renderWall({ role: "member", configured: true });

    // A member who hit the wall is as warm a signal as their admin, and a
    // second one from the same company is worth more than the first.
    expect(await screen.findByText(/admin/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI key/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  it("tells a viewer the same as a member", async () => {
    renderWall({ role: "viewer", configured: true });

    expect(await screen.findByText(/admin/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI key/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  it("hides the key field on a deployment that cannot store keys", async () => {
    renderWall({ role: "admin", configured: false });

    // There is no "door one" text at all when the deployment cannot store a
    // key — not the field, not the ask-your-admin sentence either — so the
    // form is the settled state to wait on before asserting the negative.
    expect(await screen.findByRole("button", { name: /send/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI key/i)).not.toBeInTheDocument();
  });

  it("shows the hint, not a key, once one is set", async () => {
    renderWall({ role: "admin", configured: true, hints: { openai: "sk-…4f2a" } });

    expect(await screen.findByText("sk-…4f2a")).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI key/i)).not.toBeInTheDocument();
  });

  it("keeps self-hosting as the third answer", async () => {
    renderWall({ role: "admin", configured: true });

    const sendButton = await screen.findByRole("button", { name: /send/i });
    const selfHost = screen.getByText(/Running it yourself/i);
    expect(selfHost).toBeInTheDocument();
    // Unchanged wording, moved to third — checked directly here rather than
    // via index arithmetic over `getAllByRole`, which breaks the moment an
    // unrelated link or button is added anywhere else on the wall.
    expect(screen.getByText(/no allowance at all/)).toBeInTheDocument();
    expect(
      sendButton.compareDocumentPosition(selfHost) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

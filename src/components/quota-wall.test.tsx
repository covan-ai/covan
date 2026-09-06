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
  // Door one's *field* is no longer here — `WorkspaceProviderKeys` renders it,
  // above this, and renders it whether or not the reader has run out. See that
  // component's own test. What must not happen is two components both rendering
  // a key form, so the negative below is load-bearing rather than incidental.
  it("offers an admin the message form and no key field of its own", async () => {
    renderWall({ role: "admin", configured: true });

    expect(await screen.findByRole("button", { name: /send/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI key/i)).not.toBeInTheDocument();
    // Nor the sentence pointing at an admin, to an admin who has the field.
    expect(screen.queryByText(/An admin of this workspace/i)).not.toBeInTheDocument();
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

  it("says nothing about a key on a deployment that cannot store one", async () => {
    // No PROVIDER_KEY_SECRET means there is nowhere to put a key, so pointing
    // somebody at an admin who would find no field is worse than silence. The
    // form is the settled state to wait on before asserting the negative.
    renderWall({ role: "member", configured: false });

    expect(await screen.findByRole("button", { name: /send/i })).toBeInTheDocument();
    expect(screen.queryByText(/An admin of this workspace/i)).not.toBeInTheDocument();
  });

  it("points at an admin while the role is still unknown", async () => {
    // `me` never resolves in this test — standing in for the window every load
    // passes through. `isAdmin` in `quota-wall.tsx` is `false` here on purpose,
    // and here that only decides which sentence is shown: telling an admin to
    // ask an admin for a moment is a smaller wrong than staying silent about
    // the door that would open for them. (The sharp version of this default —
    // never offering the *field* to somebody whose role is unknown — is tested
    // in `workspace-provider-keys.test.tsx`, which is where the field lives.)
    me.mockReturnValue(new Promise<never>(() => {}));
    providerKeysGet.mockResolvedValue(hintsWith({ configured: true }));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <QuotaWall />
      </QueryClientProvider>,
    );

    // The send button is not a safe anchor here — it renders on the very first
    // pass regardless of either query, so waiting on it proves nothing about
    // whether `provider-keys` has landed. "An admin of this workspace…" can
    // only appear once `configured` has resolved *and* `isAdmin` has stayed
    // `false`, which is the fact under test.
    expect(await screen.findByText(/An admin of this workspace/i)).toBeInTheDocument();
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

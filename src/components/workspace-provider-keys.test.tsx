import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me, ProviderKeyHints } from "@/lib/api-client";

import { WorkspaceProviderKeys } from "./workspace-provider-keys";

// Same arrangement as `quota-wall.test.tsx`: this component reads `["me"]` and
// `["provider-keys"]` through real `useQuery` and `ProviderKeyForm` underneath
// it writes through real `useMutation`, so a real `QueryClient` wraps it and
// only `@/lib/api-client` is mocked.
const { me, providerKeysGet, providerKeysSet, providerKeysClear } = vi.hoisted(() => ({
  me: vi.fn(),
  providerKeysGet: vi.fn(),
  providerKeysSet: vi.fn(),
  providerKeysClear: vi.fn(),
}));

// `keyHint` lives in `@/lib/provider-keys` and is deliberately not mocked: the
// boolean-versus-hint distinction the API actually returns is one of the things
// under test here, and a re-implementation of it in a factory would test
// nothing.
vi.mock("@/lib/api-client", () => ({
  api: {
    me,
    providerKeys: { get: providerKeysGet, set: providerKeysSet, clear: providerKeysClear },
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

function renderKeys({
  role,
  configured = true,
  hints,
}: {
  role: "admin" | "member" | "viewer";
  configured?: boolean;
  hints?: Partial<Pick<ProviderKeyHints, "openai" | "anthropic">>;
}) {
  me.mockResolvedValue(meWith(role));
  providerKeysGet.mockResolvedValue({
    configured,
    openai: null,
    anthropic: null,
    updatedAt: null,
    ...hints,
  } satisfies ProviderKeyHints);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceProviderKeys />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("WorkspaceProviderKeys", () => {
  // The defect this component exists to fix: it used to live inside
  // `QuotaWall`, which only mounts once the *reader's own* allowance is spent.
  // An admin with replies left — which is every admin, right up until they are
  // the one who ran out — had no key field anywhere in the product, and no way
  // to remove one either.
  it("offers an admin the key field with no reference to running out first", async () => {
    renderKeys({ role: "admin" });

    expect(await screen.findByLabelText(/OpenAI key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Anthropic key/i)).toBeInTheDocument();
    // The copy has to be true both before and after somebody runs out, since
    // the same words are read in both states. "Whenever somebody here runs
    // out" is; "carries on from here" — the wording this replaced — assumed
    // the reader was the person who had.
    expect(screen.getByText(/whenever somebody here runs out/i)).toBeInTheDocument();
  });

  it("shows a member nothing at all", async () => {
    // Their half of door one is a sentence at the wall, in `QuotaWall`. What
    // must not happen is a second component rendering a key form.
    const { container } = renderKeys({ role: "member" });

    // Both queries resolved and the component still chose to render nothing —
    // an assertion the empty container alone could not make, since it is also
    // empty while the two reads are in flight.
    await waitFor(() => expect(providerKeysGet).toHaveBeenCalled());
    await waitFor(() => expect(me).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a viewer nothing at all", async () => {
    const { container } = renderKeys({ role: "viewer" });

    await waitFor(() => expect(providerKeysGet).toHaveBeenCalled());
    await waitFor(() => expect(me).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing where the deployment cannot store a key", async () => {
    // No PROVIDER_KEY_SECRET means `PUT /workspace/provider-keys` answers 501.
    // A field that can only fail is worse than no field.
    renderKeys({ role: "admin", configured: false });

    expect(screen.queryByLabelText(/OpenAI key/i)).not.toBeInTheDocument();
  });

  it("shows the hint, not a key, once one is set", async () => {
    renderKeys({ role: "admin", hints: { openai: "sk-…4f2a" } });

    expect(await screen.findByText("sk-…4f2a")).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI key/i)).not.toBeInTheDocument();
    // And it can be taken away again — which is the other half of the defect.
    // While this lived behind `level === "spent"`, a stored key could not be
    // removed until whoever wanted it gone had burned a month of their own.
    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
  });

  it("does not show the key input before the role is known", async () => {
    // `me` never resolves — the window every load passes through. `isAdmin` is
    // `false` here on purpose, unlike `settings.tsx`'s `me ? … : true`: that
    // default is fine for a form that only locks fields, but here it would let
    // anybody paste a live credential into a field that turns out to belong to
    // a role that cannot set one. `provider-keys` resolves immediately, so this
    // is the case that can tell the two defaults apart.
    me.mockReturnValue(new Promise<never>(() => {}));
    providerKeysGet.mockResolvedValue({
      configured: true,
      openai: null,
      anthropic: null,
      updatedAt: null,
    } satisfies ProviderKeyHints);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <WorkspaceProviderKeys />
      </QueryClientProvider>,
    );

    // Let the resolved `provider-keys` query flush; `me` stays pending.
    await Promise.resolve();
    rerender(
      <QueryClientProvider client={client}>
        <WorkspaceProviderKeys />
      </QueryClientProvider>,
    );

    expect(screen.queryByLabelText(/OpenAI key/i)).not.toBeInTheDocument();
  });

  // A non-admin never gets a hint from the API at all — `GET
  // /workspace/provider-keys` answers them `true`/`false` rather than
  // `sk-…4f2a`, because four characters of a live credential are an admin's
  // business. This component would render a boolean as a hint string if it read
  // the field raw, so `keyHint` is what stands between the two shapes.
  it("never renders a boolean as though it were a hint", async () => {
    renderKeys({ role: "admin", hints: { openai: true } });

    // `true` means "a key exists" and nothing displayable, so the input comes
    // back rather than the word "true" appearing where a hint should be.
    expect(await screen.findByLabelText(/OpenAI key/i)).toBeInTheDocument();
    expect(screen.queryByText("true")).not.toBeInTheDocument();
  });
});

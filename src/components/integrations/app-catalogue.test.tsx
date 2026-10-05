import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComposioToolkit } from "@/lib/connections-api";
import { AppCatalogue } from "./app-catalogue";

/**
 * Fifteen hundred applications, arranged so somebody can find one.
 *
 * Four claims carry this file. An application already connected is not
 * offered again, because picking it would fail on a unique label with a
 * message about a name. An application Composio has no sign-in for stays
 * visible and says why, rather than being hidden — hiding it leaves somebody
 * concluding Covan has never heard of the tool they use. Typing is debounced,
 * because the query string is the cache key and "hubspot" is otherwise seven
 * requests to a third party. And a logo is always an address on our own API.
 */
const { connect } = vi.hoisted(() => ({ connect: { mutate: vi.fn(), isPending: false } }));

/**
 * What the card is told when it opens.
 *
 * Fixed here rather than varied per test: this file is about the grid, and the
 * card's own states have their own file. What it must be is *present* — the
 * hook is mocked wholesale, so a missing export throws on import and every test
 * here fails for a reason that has nothing to do with the grid.
 */
const detail: {
  data: { configured: boolean; operations: unknown[] | null; total: number | null; more: boolean };
  isPending: boolean;
  isError: boolean;
} = {
  data: { configured: true, operations: [], total: null, more: false },
  isPending: false,
  isError: false,
};

let pages = [{ configured: true, toolkits: [] as ComposioToolkit[], nextCursor: "" }];
let categories = [{ id: "crm", name: "CRM" }];
let hasNextPage = false;
const fetchNextPage = vi.fn();
/** Every (search, category) the component has asked for, in order. */
let asked: Array<[string, string]> = [];

vi.mock("@/lib/api-client", () => ({
  api: {},
  assetSrc: (path: string) => (path ? `https://api.test${path}` : ""),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-connections", () => ({
  useComposioToolkits: (search: string, category: string) => {
    asked.push([search, category]);
    return {
      data: { pages },
      isPending: false,
      isError: false,
      hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage,
    };
  },
  useComposioCategories: () => ({ data: { configured: true, categories } }),
  useConnectComposio: () => connect,
  // The card reads this when it opens. Unmocked, the module throws on the
  // missing export and every test in the file fails for the wrong reason.
  useComposioToolkitDetail: () => detail,
}));

function toolkit(over: Partial<ComposioToolkit> = {}): ComposioToolkit {
  return {
    slug: "gmail",
    name: "Gmail",
    description: "Mail",
    authSchemes: ["OAUTH2"],
    managedAuth: true,
    noAuth: false,
    logoPath: "/composio/logo?u=https%3A%2F%2Flogos.composio.dev%2Fapi%2Fgmail",
    categories: ["productivity"],
    ...over,
  };
}

function withToolkits(...list: ComposioToolkit[]) {
  pages = [{ configured: true, toolkits: list, nextCursor: "" }];
}

beforeEach(() => {
  withToolkits(toolkit(), toolkit({ slug: "linear", name: "Linear", description: "Issues" }));
  categories = [{ id: "crm", name: "CRM" }];
  hasNextPage = false;
  asked = [];
  connect.mutate.mockClear();
  fetchNextPage.mockClear();
});

describe("AppCatalogue", () => {
  it("shows the catalogue before anybody types, which is the whole change", async () => {
    render(<AppCatalogue connected={new Set()} />);
    expect(screen.getByRole("button", { name: /Gmail/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Linear/ })).toBeInTheDocument();
  });

  it("leaves out what this workspace already has", async () => {
    render(<AppCatalogue connected={new Set(["gmail"])} />);
    expect(screen.queryByRole("button", { name: /Gmail/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Linear/ })).toBeInTheDocument();
  });

  it("fetches each mark from this API rather than from Composio", async () => {
    render(<AppCatalogue connected={new Set(["linear"])} />);
    const logo = screen.getByRole("presentation", { hidden: true });
    expect(logo).toHaveAttribute(
      "src",
      "https://api.test/composio/logo?u=https%3A%2F%2Flogos.composio.dev%2Fapi%2Fgmail",
    );
  });

  it("falls back to a monogram when the catalogue published no mark", async () => {
    withToolkits(toolkit({ logoPath: "" }));
    render(<AppCatalogue connected={new Set()} />);
    expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText("G")).toBeInTheDocument();
  });

  it("opens a card instead of connecting, which is the whole of this change", async () => {
    // This used to assert `connect.mutate` on the tile press. One click on a
    // name in a grid of fifteen hundred handed the browser to a third party's
    // consent screen, having shown one truncated line of description — so the
    // assertion is now that pressing a tile does NOT connect.
    render(<AppCatalogue connected={new Set(["linear"])} />);
    await userEvent.click(screen.getByRole("button", { name: /Gmail/ }));

    expect(connect.mutate).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).getByText("gmail")).toBeInTheDocument();
  });

  it("hands the slug and the no-sign-in flag to the consent flow, from inside the card", async () => {
    render(<AppCatalogue connected={new Set(["linear"])} />);
    await userEvent.click(screen.getByRole("button", { name: /Gmail/ }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Connect/ }),
    );

    expect(connect.mutate).toHaveBeenCalledWith(
      { toolkit: "gmail", label: "Gmail", noAuth: false },
      expect.anything(),
    );
  });

  it("offers an application that needs no sign-in at all", async () => {
    // Thirty-five of these, and for as long as the flag went unread every one
    // of them said "Needs setup in Composio" and refused to be clicked.
    withToolkits(
      toolkit({ slug: "hackernews", name: "Hacker News", managedAuth: false, noAuth: true }),
    );
    render(<AppCatalogue connected={new Set()} />);
    await userEvent.click(screen.getByRole("button", { name: /Hacker News/ }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Connect/ }),
    );

    expect(connect.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ toolkit: "hackernews", noAuth: true }),
      expect.anything(),
    );
  });

  it("lets somebody read about an application nobody can connect, and offers no Connect", async () => {
    // The assertion flipped, and the flip is the decision. This tile used to be
    // an inert `<div>` at `opacity-60` — so nine tenths of the catalogue could
    // not even be read about, which is the case the card most needs to serve:
    // "Needs setup in Composio" is four truncated words on a tile and a
    // sentence in the card.
    withToolkits(toolkit({ slug: "obscure", name: "Obscure", managedAuth: false, noAuth: false }));
    render(<AppCatalogue connected={new Set()} />);

    const tile = screen.getByRole("button", { name: /Obscure/ });
    expect(screen.getByText("Needs setup in Composio")).toBeInTheDocument();

    await userEvent.click(tile);
    const card = within(screen.getByRole("dialog"));
    expect(card.queryByRole("button", { name: /Connect/ })).not.toBeInTheDocument();
    expect(card.getByText(/register a client/)).toBeInTheDocument();
  });

  it("never disables the grid while a connect is in flight", async () => {
    // One press used to grey out all forty tiles for the length of a POST that
    // is two or three upstream round trips, because `connect.isPending` was
    // handed to every tile as `busy`. The grid does not connect anything now,
    // so the only control that can disable is the one that was pressed.
    connect.isPending = true;
    try {
      withToolkits(toolkit(), toolkit({ slug: "linear", name: "Linear" }));
      render(<AppCatalogue connected={new Set()} />);
      for (const name of [/Gmail/, /Linear/]) {
        expect(screen.getByRole("button", { name })).toBeEnabled();
      }
    } finally {
      connect.isPending = false;
    }
  });

  it("waits for somebody to stop typing before asking a third party", async () => {
    // The query string is the react-query key, so without the debounce
    // "hubspot" is seven requests to a third party and six thrown answers.
    render(<AppCatalogue connected={new Set()} />);
    asked = [];

    await userEvent.type(screen.getByLabelText(/search the application catalogue/i), "hub");
    // Three keystrokes have re-rendered the component and not one of them has
    // reached the query yet.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(([search]) => search === "")).toBe(true);

    await waitFor(() => expect(asked.at(-1)?.[0]).toBe("hub"));
  });

  it("filters by a category and lets the same press clear it", async () => {
    render(<AppCatalogue connected={new Set()} />);
    await userEvent.click(screen.getByRole("button", { name: "CRM" }));
    expect(asked.at(-1)?.[1]).toBe("crm");

    await userEvent.click(screen.getByRole("button", { name: "CRM" }));
    expect(asked.at(-1)?.[1]).toBe("");
  });

  it("asks for the next page rather than truncating at forty", async () => {
    hasNextPage = true;
    render(<AppCatalogue connected={new Set()} />);
    await userEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it("renders nothing at all on a deployment with no key", async () => {
    // The card above says which variable turns this on. A second copy of that
    // sentence here would be the page telling a self-hoster twice.
    pages = [{ configured: false, toolkits: [], nextCursor: "" }];
    const { container } = render(<AppCatalogue connected={new Set()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says the catalogue had nothing, when the catalogue had nothing", async () => {
    withToolkits();
    render(<AppCatalogue connected={new Set()} />);
    await waitFor(() =>
      expect(screen.getByText(/Nothing in this part of the catalogue/i)).toBeInTheDocument(),
    );
  });

  it("does not claim it has never heard of an application that is already connected", async () => {
    // The two empty states read identically on screen and are opposite facts.
    // Searching for the application you just connected got the wrong one of
    // them — Covan saying it had never heard of it.
    render(<AppCatalogue connected={new Set(["gmail", "linear"])} />);
    await waitFor(() => expect(screen.getByText(/already connected/i)).toBeInTheDocument());
    expect(screen.queryByText(/Nothing in the catalogue matches/i)).not.toBeInTheDocument();
  });

  it("offers no Show more beside an empty grid", async () => {
    // "Nothing matches" over a live "Show more" is the page contradicting
    // itself in two lines.
    hasNextPage = true;
    render(<AppCatalogue connected={new Set(["gmail", "linear"])} />);
    await waitFor(() => expect(screen.getByText(/already connected/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Show more/i })).not.toBeInTheDocument();
  });

  it("shows an application once, however many pages it turns up on", async () => {
    // A cursor walk over fifteen hundred rows promises nothing about an
    // application appearing on one page only, and a repeat is a duplicate
    // React key: a console warning and a row that will not update.
    pages = [
      { configured: true, toolkits: [toolkit()], nextCursor: "a" },
      { configured: true, toolkits: [toolkit()], nextCursor: "" },
    ];
    render(<AppCatalogue connected={new Set()} />);
    expect(screen.getAllByRole("button", { name: /Gmail/ })).toHaveLength(1);
  });
});

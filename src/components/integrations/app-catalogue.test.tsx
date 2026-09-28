import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("hands the slug and the no-sign-in flag to the consent flow", async () => {
    render(<AppCatalogue connected={new Set(["linear"])} />);
    await userEvent.click(screen.getByRole("button", { name: /Gmail/ }));
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
    const tile = screen.getByRole("button", { name: /Hacker News/ });
    expect(tile).toBeEnabled();
    await userEvent.click(tile);
    expect(connect.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ toolkit: "hackernews", noAuth: true }),
      expect.anything(),
    );
  });

  it("keeps an application nobody can connect visible, and says why", async () => {
    withToolkits(toolkit({ slug: "obscure", name: "Obscure", managedAuth: false, noAuth: false }));
    render(<AppCatalogue connected={new Set()} />);
    expect(screen.queryByRole("button", { name: /Obscure/ })).not.toBeInTheDocument();
    expect(screen.getByText("Obscure")).toBeInTheDocument();
    expect(screen.getByText("Needs setup in Composio")).toBeInTheDocument();
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

  it("says what was searched for when nothing matches", async () => {
    withToolkits();
    render(<AppCatalogue connected={new Set()} />);
    await waitFor(() => expect(screen.getByText(/already connected/i)).toBeInTheDocument());
  });
});

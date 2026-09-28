import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComposioToolkit } from "@/lib/connections-api";
import { AppDetailDialog } from "./app-detail-dialog";

/**
 * What somebody is told before they hand an account to a third party.
 *
 * The claim this file exists for is the negative one: **a number nobody
 * measured never reaches the screen**. `DESIGN.md`'s first failure mode is "a
 * claim, number, logo, quote, or illustration the code cannot back", and the
 * operation count is the single most likely thing here to become a lie —
 * Composio publishes no total on the endpoint the route reads, so `total` is
 * null far more often than not and the card must then say nothing rather than
 * `0`, `—`, or `10+`.
 *
 * The rest is the three states an operations list can be in, which are three
 * different facts and not one: not read, read and empty, read and full.
 */
const { connect } = vi.hoisted(() => ({ connect: { mutate: vi.fn(), isPending: false } }));

type Detail = {
  data:
    | {
        configured: boolean;
        operations: Array<{
          slug: string;
          name: string;
          description: string;
          destructive: boolean | null;
        }> | null;
        total: number | null;
        more: boolean;
      }
    | undefined;
  isPending: boolean;
  isError: boolean;
};

let detail: Detail;

vi.mock("@/lib/api-client", () => ({
  api: {},
  assetSrc: (path: string) => (path ? `https://api.test${path}` : ""),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-connections", () => ({
  useComposioToolkitDetail: () => detail,
  useConnectComposio: () => connect,
}));

function toolkit(over: Partial<ComposioToolkit> = {}): ComposioToolkit {
  return {
    slug: "gmail",
    name: "Gmail",
    description: "Send and read mail from the connected account.",
    authSchemes: ["OAUTH2"],
    managedAuth: true,
    noAuth: false,
    logoPath: "",
    categories: ["productivity"],
    ...over,
  };
}

function answered(over: Partial<NonNullable<Detail["data"]>> = {}): Detail {
  return {
    data: { configured: true, operations: [], total: null, more: false, ...over },
    isPending: false,
    isError: false,
  };
}

const OPERATIONS = [
  {
    slug: "GMAIL_SEND_EMAIL",
    name: "Send email",
    description: "Send an email.",
    destructive: null,
  },
  {
    slug: "GMAIL_DELETE_MESSAGE",
    name: "Delete message",
    description: "Delete one message.",
    destructive: true,
  },
];

beforeEach(() => {
  connect.mutate.mockReset();
  connect.isPending = false;
  detail = answered();
});

const open = (over: Partial<ComposioToolkit> = {}) =>
  render(<AppDetailDialog toolkit={toolkit(over)} onClose={() => {}} />);

describe("AppDetailDialog", () => {
  it("names the application and shows its whole description, which the grid truncates", () => {
    open();
    const card = within(screen.getByRole("dialog"));
    expect(card.getByText("Gmail")).toBeInTheDocument();
    expect(card.getByText("gmail")).toBeInTheDocument();
    expect(card.getByText(/Send and read mail/)).toBeInTheDocument();
  });

  it("shows no number at all when the catalogue could not back one", () => {
    // The most important assertion in this file. `total` is null whenever the
    // page came back full or carried a cursor — which is most of the time —
    // and an inferred count is exactly what DESIGN.md's first failure mode
    // forbids. Not "0", not a dash, not "10+": nothing.
    detail = answered({ operations: OPERATIONS, total: null, more: true });
    open();
    const card = screen.getByRole("dialog");
    expect(card.textContent).not.toMatch(/\d+\s*operations?/i);
  });

  it("shows the number when the route earned one", () => {
    detail = answered({ operations: OPERATIONS, total: 2, more: false });
    open();
    expect(within(screen.getByRole("dialog")).getByText("2 operations")).toBeInTheDocument();
  });

  it("lists the operations, and marks only the ones Composio annotated", () => {
    detail = answered({ operations: OPERATIONS, total: 2, more: false });
    open();
    const card = within(screen.getByRole("dialog"));
    expect(card.getByText("GMAIL_SEND_EMAIL")).toBeInTheDocument();
    expect(card.getByText("GMAIL_DELETE_MESSAGE")).toBeInTheDocument();
    // `null` means not annotated, which is not the same as safe — so exactly
    // one chip, on the one that says `true`.
    expect(card.getAllByText("Can change things")).toHaveLength(1);
  });

  it("says the operations could not be read, and keeps Connect live", () => {
    // `null` operations. Nobody should be stopped from connecting Gmail
    // because a catalogue read wobbled, and Connect does not depend on the list.
    detail = answered({ operations: null });
    open();
    const card = within(screen.getByRole("dialog"));
    expect(card.getByText(/could not be read/)).toBeInTheDocument();
    expect(card.getByRole("button", { name: /Connect/ })).toBeEnabled();
  });

  it("tells an empty list apart from an unread one", () => {
    // `[]` is a fact about the application; `null` is a fact about the request.
    // Collapsing them would turn a catalogue hiccup into a claim.
    detail = answered({ operations: [] });
    open();
    expect(within(screen.getByRole("dialog")).getByText(/lists no operations/)).toBeInTheDocument();
  });

  it("says it is loading rather than showing an empty list", () => {
    detail = { data: undefined, isPending: true, isError: false };
    open();
    const card = within(screen.getByRole("dialog"));
    expect(card.getByText("Loading…")).toBeInTheDocument();
    expect(card.queryByText(/lists no operations/)).not.toBeInTheDocument();
  });

  it("connects with the slug and the sign-in flag when asked", async () => {
    open();
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }),
    );
    expect(connect.mutate).toHaveBeenCalledWith(
      { toolkit: "gmail", label: "Gmail", noAuth: false },
      expect.anything(),
    );
  });

  it("offers no Connect for an application nobody can connect, and says what is in the way", () => {
    open({ managedAuth: false, noAuth: false, name: "Obscure", slug: "obscure" });
    const card = within(screen.getByRole("dialog"));
    expect(card.queryByRole("button", { name: /Connect/ })).not.toBeInTheDocument();
    expect(card.getByText(/register a client/)).toBeInTheDocument();
  });

  it("says a no-sign-in application needs none, in words rather than in OAUTH2", () => {
    // `authSchemes` is Composio's vocabulary. A person deciding whether to
    // connect Hacker News does not need to be shown the string `OAUTH2`.
    open({ slug: "hackernews", name: "Hacker News", managedAuth: false, noAuth: true });
    const card = within(screen.getByRole("dialog"));
    expect(card.getByText("No sign-in needed")).toBeInTheDocument();
    expect(card.getByRole("button", { name: /Connect/ })).toBeInTheDocument();
  });

  it("draws nothing at all when no application is open", () => {
    render(<AppDetailDialog toolkit={null} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection, ToolConnection } from "@/lib/connections-api";
import { ConnectedStarters } from "./connected-starters";

const tools: { current: ToolConnection[] } = { current: [] };
const sources: { current: Connection[] } = { current: [] };

// The real hooks answer with a wrapper — `{ connections, tools }` and
// `{ connections, providers }` — and mocking them as bare lists is how a test
// passes against a shape the product never sees. Typecheck caught exactly that
// here; the shape below is the one on the wire.
vi.mock("@/hooks/use-connections", () => ({
  useToolConnections: () => ({ data: { connections: tools.current, tools: [] } }),
  useConnections: () => ({ data: { connections: sources.current, providers: [] } }),
}));

vi.mock("@/lib/api-client", () => ({
  assetSrc: (path: string) => (path ? `https://api.test${path}` : ""),
}));

const tool = (over: Partial<ToolConnection> = {}): ToolConnection => ({
  id: "t1",
  label: "Gmail",
  transport: "composio",
  baseUrl: "",
  allowedMethods: ["GET"],
  summary: null,
  rpc: null,
  toolkitSlug: "gmail",
  status: "active",
  logoPath: "/composio/logo?u=gmail",
  createdAt: 0,
  ...over,
});

const source = (over: Partial<Connection> = {}): Connection => ({
  id: "c1",
  provider: "notion",
  accountLabel: "Northwind",
  bundleId: "b1",
  bundleName: "Team",
  userId: "u1",
  status: "active",
  pausedReason: null,
  pausedCode: null,
  needsFolder: false,
  folderName: null,
  syncIntervalMinutes: 60,
  nextSyncAt: null,
  lastSyncAt: null,
  documentCount: 3,
  createdAt: 0,
  ...over,
});

beforeEach(() => {
  tools.current = [];
  sources.current = [];
});

describe("ConnectedStarters", () => {
  it("draws nothing at all — not even its heading — for a workspace with no apps", () => {
    // The heading is inside the component for this reason. Left in the route
    // it would label an empty region on every workspace that has connected
    // nothing, which is most of them on day one.
    const { container } = render(<ConnectedStarters onPick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers one line per connected app, under a heading that says what they are", () => {
    tools.current = [tool()];
    render(<ConnectedStarters onPick={() => {}} />);

    expect(screen.getByText("Connected apps")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /What's waiting in my inbox/ })).toBeInTheDocument();
  });

  it("fetches the mark for an app whose logo lives in the catalogue", () => {
    tools.current = [tool()];
    render(<ConnectedStarters onPick={() => {}} />);

    expect(screen.getByRole("presentation", { hidden: true })).toHaveAttribute(
      "src",
      "https://api.test/composio/logo?u=gmail",
    );
  });

  it("draws the mark it already holds for a source, without a request", () => {
    // Notion and Drive are inline SVGs. Asking the network for a logo we ship
    // would be a request per row for a file already in the bundle.
    sources.current = [source()];
    const { container } = render(<ConnectedStarters onPick={() => {}} />);

    expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("hands the sentence back rather than sending it", async () => {
    tools.current = [tool({ toolkitSlug: "linear", label: "Linear" })];
    const onPick = vi.fn();
    render(<ConnectedStarters onPick={onPick} />);

    await userEvent.click(screen.getByRole("button", { name: /assigned to me in Linear/ }));
    expect(onPick).toHaveBeenCalledWith("What's assigned to me in Linear?");
  });

  it("says nothing about an app nobody finished connecting", () => {
    tools.current = [tool({ status: "pending" })];
    const { container } = render(<ConnectedStarters onPick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows one row for an app that reached us both ways", () => {
    tools.current = [tool({ toolkitSlug: "notion", label: "Notion", logoPath: "/logo?u=notion" })];
    sources.current = [source({ provider: "notion" })];
    render(<ConnectedStarters onPick={() => {}} />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

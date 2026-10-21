import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachBundleDialog } from "./attach-bundle-dialog";

const store = {
  agents: [] as {
    id: string;
    name: string;
    emoji: string;
    bundleIds: string[];
    myAccess: "use" | "edit" | "manage";
  }[],
  attachBundle: vi.fn(),
  detachBundle: vi.fn(),
};
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

const FOLDER = { id: "b-2", name: "Old pricing" };

beforeEach(() => {
  vi.clearAllMocks();
  store.attachBundle.mockResolvedValue(true);
  store.agents = [
    { id: "a1", name: "Ada", emoji: "📈", bundleIds: ["b-2"], myAccess: "edit" },
    { id: "a2", name: "Ops bot", emoji: "🧭", bundleIds: [], myAccess: "manage" },
    // Can use it, cannot change what it reads (0104).
    { id: "a3", name: "Helpdesk", emoji: "💬", bundleIds: [], myAccess: "use" },
  ];
});

describe("AttachBundleDialog", () => {
  it("lists the agents the person can edit, with the folder's state on each", () => {
    render(<AttachBundleDialog bundle={FOLDER} onOpenChange={vi.fn()} />);

    expect(screen.getByRole("dialog")).toHaveTextContent("Attach Old pricing");
    expect(screen.getByRole("switch", { name: "Attach Old pricing to Ada" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Attach Old pricing to Ops bot" })).not.toBeChecked();
    expect(screen.queryByRole("switch", { name: /Helpdesk/ })).toBeNull();
  });

  it("attaches and detaches with the same words as the agent's own tab", async () => {
    render(<AttachBundleDialog bundle={FOLDER} onOpenChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("switch", { name: "Attach Old pricing to Ops bot" }));
    expect(store.attachBundle).toHaveBeenCalledWith("a2", "b-2");

    await userEvent.click(screen.getByRole("switch", { name: "Attach Old pricing to Ada" }));
    expect(store.detachBundle).toHaveBeenCalledWith("a1", "b-2");
  });

  it("says so when there is no agent the person could attach it to", () => {
    store.agents = [{ id: "a3", name: "Helpdesk", emoji: "💬", bundleIds: [], myAccess: "use" }];
    render(<AttachBundleDialog bundle={FOLDER} onOpenChange={vi.fn()} />);

    expect(screen.getByText(/nothing to attach it to/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("closes on Done, and is closed while there is no folder", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<AttachBundleDialog bundle={FOLDER} onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(<AttachBundleDialog bundle={null} onOpenChange={onOpenChange} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MemoryNote } from "@/lib/api-client";

const h = vi.hoisted(() => ({
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  canWrite: true,
}));

vi.mock("@/lib/api-client", () => ({
  api: { memory: { add: h.add, update: h.update, remove: h.remove } },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));
vi.mock("@/lib/workspace-role", () => ({
  useWorkspaceRole: () => ({ canWrite: h.canWrite, isAdmin: h.canWrite }),
}));

import { MemoryNotesSection } from "./memory-notes-section";

const NOTE: MemoryNote = {
  id: "n1",
  about: "team",
  scope: "workspace",
  text: "Support answers within two hours.",
  source: "agent",
  mine: false,
  createdAt: 1_700_000_000_000,
};

function mount(props: Partial<React.ComponentProps<typeof MemoryNotesSection>> = {}) {
  const onChanged = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryNotesSection
        label="About the team"
        lede="Everyone here can read these."
        notes={[NOTE]}
        canAdd
        about="team"
        onChanged={onChanged}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onChanged };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.canWrite = true;
  h.add.mockResolvedValue(NOTE);
  h.remove.mockResolvedValue(undefined);
});

describe("MemoryNotesSection", () => {
  it("counts what is typed against the 280 limit and holds the input to it", async () => {
    mount();
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("maxLength", "280");
    expect(screen.getByText("0/280")).toBeInTheDocument();
    await userEvent.type(input, "Ada");
    expect(screen.getByText("3/280")).toBeInTheDocument();
  });

  it("does not add an empty note, and clears the input after one that went through", async () => {
    const { onChanged } = mount();
    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox"), "  Refunds go through Finance ");
    await userEvent.click(add);
    expect(h.add).toHaveBeenCalledWith({ text: "Refunds go through Finance", about: "team" });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("keeps what was typed when the API refuses it", async () => {
    const { ApiError } = await import("@/lib/api-client");
    h.add.mockRejectedValue(new ApiError(400, "A note is at most 280 characters. Say it shorter."));
    const { onChanged } = mount();
    await userEvent.type(screen.getByRole("textbox"), "Too much");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() =>
      expect(h.error).toHaveBeenCalledWith("A note is at most 280 characters. Say it shorter."),
    );
    expect(screen.getByRole("textbox")).toHaveValue("Too much");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("has no form when the caller cannot add", () => {
    mount({ canAdd: false });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("does not tell a viewer to write a note when there is nowhere to write it", () => {
    mount({ canAdd: false, notes: [] });
    expect(
      screen.getByText("Nothing yet. Tell an agent something worth keeping."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/or write it here/)).not.toBeInTheDocument();
  });

  it("tells someone who can add that they may write one", () => {
    mount({ canAdd: true, notes: [] });
    expect(
      screen.getByText("Nothing yet. Tell an agent something worth keeping, or write it here."),
    ).toBeInTheDocument();
  });

  it("lets a viewer delete their own private note but not a team one", () => {
    h.canWrite = false;
    mount({
      about: "person",
      notes: [
        { ...NOTE, id: "a", scope: "owner", about: "person", mine: true },
        { ...NOTE, id: "b" },
      ],
    });
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
  });
});

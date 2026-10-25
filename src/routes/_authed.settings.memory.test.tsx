import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { Me, MemoryNote } from "@/lib/api-client";
import { meFixture } from "@/test/me-fixture";
import { renderRoute } from "@/test/settings-route";
import { inTurkish } from "@/test/in-turkish";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
}));

const h = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

let me: Me;
vi.mock("@/lib/api-client", () => ({
  api: {
    me: () => Promise.resolve(me),
    memory: { list: h.list, add: h.add, update: h.update, remove: h.remove },
  },
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

const { Route } = await import("./_authed.settings.memory");

function note(over: Partial<MemoryNote> & Pick<MemoryNote, "id" | "text">): MemoryNote {
  return {
    about: "team",
    scope: "workspace",
    source: "agent",
    mine: false,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

const NOTES: MemoryNote[] = [
  note({ id: "n1", text: "Support answers within two hours." }),
  note({
    id: "n2",
    text: "Prefers short replies.",
    about: "person",
    scope: "owner",
    mine: true,
    source: "person",
  }),
  note({ id: "n3", text: "Launch review is on Fridays.", scope: "owner", mine: true }),
  // The API never sends another person's private note; the page would not show it if it did.
  note({ id: "n4", text: "Somebody else's private note.", about: "person", scope: "owner" }),
];

const group = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  vi.clearAllMocks();
  me = meFixture();
  h.list.mockResolvedValue({ notes: NOTES });
  h.add.mockResolvedValue(note({ id: "new", text: "x" }));
  h.update.mockResolvedValue(note({ id: "n3", text: "x" }));
  h.remove.mockResolvedValue(undefined);
});

describe("/settings/memory", () => {
  it("lists the team's notes under About the team and your own private ones under About you", async () => {
    renderRoute(Route);
    const team = within(group("About the team"));
    expect(await team.findByText("Support answers within two hours.")).toBeInTheDocument();
    expect(team.queryByText("Prefers short replies.")).not.toBeInTheDocument();
    const you = within(group("About you"));
    expect(you.getByText("Prefers short replies.")).toBeInTheDocument();
    expect(you.getByText("Launch review is on Fridays.")).toBeInTheDocument();
    expect(screen.queryByText("Somebody else's private note.")).not.toBeInTheDocument();
  });

  it("says where each note came from", async () => {
    renderRoute(Route);
    const team = within(group("About the team"));
    await team.findByText("Support answers within two hours.");
    expect(team.getByText("From a conversation")).toBeInTheDocument();
    expect(within(group("About you")).getByText("Written here")).toBeInTheDocument();
  });

  it("links the lede to the documentation", async () => {
    renderRoute(Route);
    const link = await screen.findByRole("link", { name: /learn more/i });
    expect(link).toHaveAttribute("href", "https://covan.app/docs/knowledge");
  });

  it("gives a viewer no Add, no Delete and no Share in the team group, and still lets them write about themselves", async () => {
    me = meFixture({ role: "viewer" });
    renderRoute(Route);
    const team = within(group("About the team"));
    await team.findByText("Support answers within two hours.");
    // Settle `me` before asserting absences: the role is false while it loads.
    await new Promise((r) => setTimeout(r, 0));
    expect(team.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(team.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    const you = within(group("About you"));
    expect(you.getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(you.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    expect(you.queryByRole("button", { name: "Share with team" })).not.toBeInTheDocument();
  });

  it("offers Share with team on a private note about the team, and only that one", async () => {
    renderRoute(Route);
    const you = within(group("About you"));
    await you.findByText("Launch review is on Fridays.");
    await waitFor(() =>
      expect(you.getAllByRole("button", { name: "Share with team" })).toHaveLength(1),
    );
    await userEvent.click(you.getByRole("button", { name: "Share with team" }));
    expect(h.update).toHaveBeenCalledWith("n3", { scope: "workspace" });
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    expect(h.success).toHaveBeenCalled();
  });

  it("deletes a note and reloads the list", async () => {
    renderRoute(Route);
    const team = within(group("About the team"));
    await team.findByText("Support answers within two hours.");
    await waitFor(() => expect(team.getByRole("button", { name: "Delete" })).toBeInTheDocument());
    await userEvent.click(team.getByRole("button", { name: "Delete" }));
    expect(h.remove).toHaveBeenCalledWith("n1");
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
  });

  it("adds a team note from the team group and a private one from About you", async () => {
    renderRoute(Route);
    const team = within(group("About the team"));
    await team.findByText("Support answers within two hours.");
    await waitFor(() => expect(team.getByRole("button", { name: "Add" })).toBeInTheDocument());
    await userEvent.type(team.getByRole("textbox"), "Refunds go through Finance");
    await userEvent.click(team.getByRole("button", { name: "Add" }));
    expect(h.add).toHaveBeenLastCalledWith({ text: "Refunds go through Finance", about: "team" });

    const you = within(group("About you"));
    await userEvent.type(you.getByRole("textbox"), "Call me Ada");
    await userEvent.click(you.getByRole("button", { name: "Add" }));
    expect(h.add).toHaveBeenLastCalledWith({ text: "Call me Ada", about: "person" });
  });

  it("shows the API's own words when a change is refused", async () => {
    const { ApiError } = await import("@/lib/api-client");
    h.remove.mockRejectedValue(new ApiError(400, "That is already noted."));
    renderRoute(Route);
    const team = within(group("About the team"));
    await team.findByText("Support answers within two hours.");
    await waitFor(() => expect(team.getByRole("button", { name: "Delete" })).toBeInTheDocument());
    await userEvent.click(team.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.error).toHaveBeenCalledWith("That is already noted."));
  });

  it("says so when there is nothing yet", async () => {
    h.list.mockResolvedValue({ notes: [] });
    renderRoute(Route);
    expect(
      (
        await screen.findAllByText(
          "Nothing yet. Tell an agent something worth keeping, or write it here.",
        )
      ).length,
    ).toBe(2);
  });

  it("reads in Turkish", async () => {
    await inTurkish(async () => {
      renderRoute(Route);
      expect(await screen.findByRole("heading", { name: "Hafıza" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Ekiple ilgili" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Sizinle ilgili" })).toBeInTheDocument();
      expect((await screen.findAllByText("Bir sohbetten")).length).toBeGreaterThan(0);
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionRow } from "./session-row";
import type { ChatSession } from "@/lib/agents-store";

const session = (patch: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: "s1",
    agentId: "a1",
    title: "Q3 pricing review",
    visibility: "private",
    kind: "chat",
    ownerId: "u1",
    messages: [],
    messageCount: 4,
    updatedAt: Date.now(),
    ...patch,
  }) as ChatSession;

function renderRow(
  patch: Partial<ChatSession> = {},
  handlers: Partial<Parameters<typeof SessionRow>[0]> = {},
) {
  const onOpen = vi.fn();
  const onRename = vi.fn();
  const onDelete = vi.fn();
  render(
    <SessionRow
      session={session(patch)}
      active={false}
      onOpen={onOpen}
      onRename={onRename}
      onDelete={onDelete}
      {...handlers}
    />,
  );
  return { onOpen, onRename, onDelete };
}

const renameButton = () => screen.getByRole("button", { name: "Rename chat" });
const nameField = () => screen.getByRole("textbox", { name: "Chat name" });

describe("a session in the sidebar", () => {
  it("shows the name it was given", () => {
    renderRow();
    expect(screen.getByText("Q3 pricing review")).toBeInTheDocument();
  });

  it("falls back to a placeholder while the title is still being written", () => {
    renderRow({ title: null });
    expect(screen.getByText("New chat")).toBeInTheDocument();
  });

  it("names an untitled brainstorm as a brainstorm", () => {
    renderRow({ title: null, kind: "brainstorm" });
    expect(screen.getByText("New brainstorm")).toBeInTheDocument();
  });

  it("opens the chat when the name is clicked", async () => {
    const { onOpen } = renderRow();
    await userEvent.click(screen.getByText("Q3 pricing review"));
    expect(onOpen).toHaveBeenCalledWith("s1");
  });
});

describe("renaming a session", () => {
  it("saves the new name", async () => {
    const { onRename } = renderRow();

    await userEvent.click(renameButton());
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Pricing v2{Enter}");

    expect(onRename).toHaveBeenCalledWith("s1", "Pricing v2");
  });

  // The field opens with the current name selected, so the common case —
  // replacing the machine's guess — is one keystroke rather than a clear first.
  it("opens on the current name", async () => {
    renderRow();
    await userEvent.click(renameButton());
    expect(nameField()).toHaveValue("Q3 pricing review");
  });

  it("abandons the edit on Escape", async () => {
    const { onRename } = renderRow();

    await userEvent.click(renameButton());
    await userEvent.type(nameField(), " and more{Escape}");

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Q3 pricing review")).toBeInTheDocument();
  });

  // Clicking away is how most people leave a field, and losing the edit there
  // reads as the app dropping what you typed.
  it("saves when the field loses focus", async () => {
    const { onRename } = renderRow();

    await userEvent.click(renameButton());
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Pricing v2");
    await userEvent.tab();

    expect(onRename).toHaveBeenCalledWith("s1", "Pricing v2");
  });

  it("does not ask the server to store a blank name", async () => {
    const { onRename } = renderRow();

    await userEvent.click(renameButton());
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "   {Enter}");

    expect(onRename).not.toHaveBeenCalled();
  });

  it("says nothing to the server when the name did not change", async () => {
    const { onRename } = renderRow();

    await userEvent.click(renameButton());
    await userEvent.type(nameField(), "{Enter}");

    expect(onRename).not.toHaveBeenCalled();
  });

  // The row is a button; a field inside it is not, and a click meant for the
  // text must not navigate away mid-edit.
  it("does not open the chat while the name is being edited", async () => {
    const { onOpen } = renderRow();

    await userEvent.click(renameButton());
    await userEvent.click(nameField());

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("deletes on request", async () => {
    const { onDelete } = renderRow();
    await userEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    expect(onDelete).toHaveBeenCalledWith("s1");
  });
});

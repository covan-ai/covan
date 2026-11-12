import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import type { InboxItem } from "@/lib/api-client";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a href="#thread" className={className}>
      {children}
    </a>
  ),
}));
const h = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  api: { approvals: { answer: h.answer } },
  ApiError: class ApiError extends Error {
    status = 500;
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { DelegatedRow, InboxRow } from "./inbox-row";

const item = (origin: "chat" | "routine" | "wake"): InboxItem =>
  ({
    sessionId: "conv-1",
    agentId: "agent-1",
    title: "Routine: Seat requests",
    kind: "chat",
    visibility: "private",
    ownerId: "owner-1",
    ownerName: "Ada",
    sharedBy: null,
    preview: null,
    unread: true,
    unreadCount: 1,
    needsYou: {
      kind: "approval",
      pausedTurnId: "pause-1",
      origin,
      summary: "POST to Box office?",
      since: Date.now(),
    },
    running: null,
    lastActivityAt: Date.now(),
  }) as unknown as InboxItem;

function renderRow(origin: "chat" | "routine" | "wake") {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <InboxRow
        item={item(origin)}
        agent={{ name: "Box office agent", avatar: null }}
        onOpen={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("an approval in the Inbox", () => {
  it("is answered from the row when nobody was watching when it was asked", async () => {
    h.answer.mockResolvedValue({ status: "approved" });
    renderRow("routine");

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(h.answer).toHaveBeenCalledWith("pause-1", true));
  });

  it("sends a conversation's question to its conversation, with no buttons here", () => {
    renderRow("chat");
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("shows an admin whose routine is asking, and answers it from the row", async () => {
    h.answer.mockResolvedValue({ status: "declined" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DelegatedRow
          request={{
            id: "pause-2",
            agentId: "agent-1",
            agentName: "Box office agent",
            ownerName: "Ada",
            routineName: "Seat requests",
            tool: "http_request",
            summary: "POST to Box office?",
            proposal: null,
            createdAt: Date.now(),
            expiresAt: Date.now() + 86_400_000,
          }}
          agent={undefined}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("For Ada's routine “Seat requests”")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(h.answer).toHaveBeenCalledWith("pause-2", false));
  });

  // The buttons sit beside the link, never inside it: a button in a link is
  // two controls in one, and a click would also open the thread.
  it("keeps the buttons out of the thread's link", () => {
    renderRow("wake");
    const link = screen.getByRole("link");
    expect(link.querySelector("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });
});

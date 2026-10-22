import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { Agent } from "@/lib/agents-store";

const h = vi.hoisted(() => ({
  createBundle: vi.fn(),
  attachBundle: vi.fn(),
  uploadToBundle: vi.fn(),
}));
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => h }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FirstDocsStep } from "./first-docs-step";

const AGENT = { id: "a9", name: "Support", avatar: "headset", bundleIds: [] } as unknown as Agent;

beforeEach(() => {
  vi.clearAllMocks();
  h.createBundle.mockResolvedValue({ id: "b9", name: "Support's documents" });
  h.attachBundle.mockResolvedValue(true);
  h.uploadToBundle.mockResolvedValue({ id: "d1" });
});

describe("FirstDocsStep", () => {
  it("makes the agent's folder on the first upload, and marks the card uploaded", async () => {
    const user = userEvent.setup();
    render(<FirstDocsStep agent={AGENT} />);

    await user.click(screen.getByRole("button", { name: "Upload Policies or a handbook" }));
    const file = new File(["refunds within 30 days"], "refunds.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("Choose files"), file);

    await waitFor(() => expect(h.uploadToBundle).toHaveBeenCalledWith("b9", file));
    expect(h.createBundle).toHaveBeenCalledWith("Support's documents");
    expect(h.attachBundle).toHaveBeenCalledWith("a9", "b9");
    const card = screen.getByText("Policies or a handbook").closest("li")!;
    expect(within(card).getByText(/Uploaded · refunds\.txt/)).toBeInTheDocument();
  });

  it("offers Drive and three templates for a team with nothing written down", () => {
    render(<FirstDocsStep agent={AGENT} />);
    expect(screen.getByRole("link", { name: "Connect Google Drive" })).toHaveAttribute(
      "href",
      "/settings/integrations",
    );
    expect(screen.getAllByRole("button", { name: /^Download / })).toHaveLength(3);
  });
});

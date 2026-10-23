import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { inTurkish } from "@/test/in-turkish";
import { ReadOnlyNotice } from "./empty-page";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

describe("ReadOnlyNotice", () => {
  it("names the workspace in the sentence", () => {
    render(<ReadOnlyNotice workspaceName="Acme" viewerName="Mina" />);
    expect(
      screen.getByRole("heading", { name: "You can read Acme, not change it" }),
    ).toBeInTheDocument();
  });

  it("says it in Turkish when the page is", async () => {
    await inTurkish(() => {
      render(<ReadOnlyNotice workspaceName="Acme" viewerName="Mina" />);
      expect(screen.getByRole("heading").textContent).toContain("Acme");
      expect(screen.getByRole("heading").textContent).not.toMatch(/You can read/);
    });
  });
});

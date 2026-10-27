import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", () => ({ assetSrc: (path: string) => path }));

import { findUseCase, type UseCase } from "@/lib/use-cases";
import { UseCaseCard } from "./use-case-card";
import type { CardState } from "./use-case-facts";

function card(id: string): UseCase {
  const u = findUseCase(id);
  if (!u) throw new Error(`no use case ${id}`);
  return u;
}

const READY: CardState = { kind: "ready", notes: [], schedule: "Weekdays 08:00" };

describe("UseCaseCard", () => {
  it("shows the apps, the title, the prompt and when it runs", () => {
    render(
      <UseCaseCard
        useCase={card("daily-brief")}
        state={READY}
        connected={new Set(["gmail"])}
        interactive
      />,
    );
    expect(screen.getByText("Daily brief")).toBeInTheDocument();
    expect(screen.getByText(/my top three priorities/)).toBeInTheDocument();
    expect(screen.getByText("Weekdays 08:00")).toBeInTheDocument();
    // A connected app by its name; one that is not, said so and greyed.
    expect(screen.getByRole("img", { name: "Gmail" })).not.toHaveClass("opacity-40");
    const outlook = screen.getByRole("img", { name: "Outlook not connected" });
    expect(outlook).toHaveClass("opacity-40");
  });

  it("draws a word where there is no app to show", () => {
    render(
      <UseCaseCard useCase={card("first-week")} state={READY} connected={new Set()} interactive />,
    );
    expect(screen.getByText("Knowledge")).toBeInTheDocument();
  });

  it("is one button when it can be set up, and picking it says so", async () => {
    const onPick = vi.fn();
    render(
      <UseCaseCard
        useCase={card("daily-brief")}
        state={{ ...READY, notes: ["Gmail or Outlook not connected"] }}
        connected={new Set()}
        interactive
        onPick={onPick}
        coach
      />,
    );
    const button = screen.getByRole("button", { name: "Daily brief" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(within(button).getByText("Set up")).toBeInTheDocument();
    expect(within(button).getByText("Gmail or Outlook not connected")).toBeInTheDocument();
    expect(button).toHaveAttribute("data-coach", "use-case-card");
    await userEvent.click(button);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("offers Create on an agent card", () => {
    render(
      <UseCaseCard
        useCase={card("researcher")}
        state={{ kind: "ready", notes: [], schedule: "Agent" }}
        connected={new Set()}
        interactive
      />,
    );
    expect(screen.getByText("Create")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("says why when it is blocked, and offers nothing", () => {
    render(
      <UseCaseCard
        useCase={card("gap-report")}
        state={{ kind: "blocked", reason: "Only an admin can set this one up." }}
        connected={new Set()}
        interactive
      />,
    );
    expect(screen.getByText("Only an admin can set this one up.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Set up")).not.toBeInTheDocument();
  });

  it("is a picture with nothing to press when it is not interactive", () => {
    render(
      <UseCaseCard
        useCase={card("daily-brief")}
        state={READY}
        connected={new Set()}
        interactive={false}
      />,
    );
    expect(screen.getByText("Daily brief")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Set up")).not.toBeInTheDocument();
  });
});

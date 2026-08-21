import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionCard } from "./question-card";

const OPTIONS = [
  { id: "engineering", label: "Engineering" },
  { id: "design", label: "Design" },
];

describe("QuestionCard", () => {
  it("reports the id, not the label, when an option is picked", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <QuestionCard title="What do you do?" options={OPTIONS} value={null} onSelect={onSelect} />,
    );

    await user.click(screen.getByRole("button", { name: "Design" }));

    expect(onSelect).toHaveBeenCalledWith("design");
  });

  it("marks the chosen option as pressed", () => {
    render(
      <QuestionCard title="What do you do?" options={OPTIONS} value="design" onSelect={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Engineering" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("offers no way out unless one is given", () => {
    render(
      <QuestionCard title="What do you do?" options={OPTIONS} value={null} onSelect={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
  });

  it("offers a way out when one is given", async () => {
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(
      <QuestionCard
        title="How did you hear about us?"
        options={OPTIONS}
        value={null}
        onSelect={vi.fn()}
        onSkip={onSkip}
        skipLabel="Skip"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(onSkip).toHaveBeenCalled();
  });
});

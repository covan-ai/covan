import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ModelChip } from "./model-chip";

const models = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "gpt-4.1", "gpt-5"];
const prices = {
  unit: "credits" as const,
  byModel: { "claude-haiku-4-5": 1, "claude-sonnet-5": 2, "claude-opus-5": 6, "gpt-4.1": 8 },
};

function open(onChange = vi.fn(), agentModel = "gpt-4.1", value = "claude-sonnet-5") {
  render(
    <ModelChip
      value={value}
      agentModel={agentModel}
      models={models}
      prices={prices}
      onChange={onChange}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: /^Model:/ }), { key: "Enter" });
  return screen.getByRole("menu");
}

describe("ModelChip", () => {
  it("says the tier it is on, by its word", () => {
    render(
      <ModelChip
        value="claude-opus-5"
        agentModel="gpt-4.1"
        models={models}
        prices={prices}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Model: Best" })).toBeInTheDocument();
  });

  it("offers the three tiers with their ids, the agent's own as Agent default, and says what it applies to", () => {
    const menu = open();
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(items[0]).toMatch(/^Fastclaude-haiku-4-5.*1 credit$/);
    expect(items[1]).toMatch(/^Standardclaude-sonnet-5.*2 credits$/);
    expect(items[2]).toMatch(/^Bestclaude-opus-5.*6 credits$/);
    expect(items[3]).toMatch(/^gpt-4\.1Agent default.*8 credits$/);
    expect(items[4]).toBe("All models…");
    expect(menu).toHaveTextContent("Model for this message");
    expect(menu).toHaveTextContent(
      "Applies to this message. Change the agent’s default in Configuration.",
    );
  });

  it("hands back the model picked", () => {
    const onChange = vi.fn();
    const menu = open(onChange);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Best/ }));
    expect(onChange).toHaveBeenCalledWith("claude-opus-5");
  });

  it("lists every model this install serves under All models", () => {
    const menu = open();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "All models…" }));
    const items = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(items.some((t) => t?.startsWith("gpt-5"))).toBe(true);
    expect(items.some((t) => t?.startsWith("claude-haiku-4-5"))).toBe(true);
  });
});

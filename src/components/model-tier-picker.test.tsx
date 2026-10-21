import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelTierPicker } from "./model-tier-picker";

const ALL = ["gpt-4.1", "gpt-4.1-mini", "claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"];
const costs = {
  "gpt-4.1": 0.008,
  "gpt-4.1-mini": 0.002,
  "claude-haiku-4-5": 0.004,
  "claude-sonnet-5": 0.012,
  "claude-opus-5": 0.03,
};

function renderPicker(value: string, models = ALL) {
  const onChange = vi.fn();
  const view = render(
    <ModelTierPicker
      value={value}
      onChange={onChange}
      models={models}
      prices={{ unit: "usd", byModel: costs }}
    />,
  );
  return { onChange, ...view };
}

describe("ModelTierPicker", () => {
  it("offers the three tiers as words, with what each is for", () => {
    renderPicker("claude-sonnet-5");

    const group = screen.getByRole("radiogroup", { name: "Model" });
    expect(group).toHaveTextContent("Fast");
    expect(group).toHaveTextContent("Quick answers, lowest cost");
    expect(group).toHaveTextContent("Balanced");
    expect(group).toHaveTextContent("Smartest");
    expect(screen.getByRole("radio", { name: /Balanced/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Fast/ })).toHaveAttribute("aria-checked", "false");
  });

  it("hands back the model behind the word", async () => {
    const { onChange } = renderPicker("claude-sonnet-5");

    await userEvent.click(screen.getByRole("radio", { name: /Smartest/ }));
    expect(onChange).toHaveBeenCalledWith("claude-opus-5");
  });

  it("offers only the tiers whose model is served", () => {
    renderPicker("claude-haiku-4-5", ["gpt-4.1", "claude-haiku-4-5"]);

    expect(screen.getByRole("radio", { name: /Fast/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Balanced/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Smartest/ })).toBeNull();
  });

  it("shows a model that is no tier as Custom, with its id, rather than as nothing", () => {
    renderPicker("gpt-4.1");

    const custom = screen.getByRole("radio", { name: /Custom/ });
    expect(custom).toHaveAttribute("aria-checked", "true");
    expect(custom).toHaveTextContent("gpt-4.1");
    for (const word of ["Fast", "Balanced", "Smartest"]) {
      expect(screen.getByRole("radio", { name: new RegExp(word) })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    }
  });

  it("keeps the full list a disclosure away", () => {
    renderPicker("claude-sonnet-5");

    expect(screen.getByText("All models")).toBeInTheDocument();
    // The Select is inside the closed details; its value is still the id.
    expect(screen.getByRole("combobox")).toHaveTextContent("claude-sonnet-5");
  });

  it("is exactly the list on an install that serves no tier model", () => {
    renderPicker("gpt-4.1", ["gpt-4.1", "gpt-4.1-mini"]);

    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByText("All models")).toBeNull();
    expect(screen.getByRole("combobox")).toHaveTextContent("gpt-4.1");
  });

  it("spends no amber on a selection", () => {
    const { container } = renderPicker("claude-sonnet-5");

    expect(container.innerHTML).not.toMatch(/bg-brand/);
  });
});

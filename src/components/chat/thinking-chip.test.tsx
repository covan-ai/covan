import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ThinkingChip } from "./thinking-chip";

describe("ThinkingChip", () => {
  it("says how long the next message is thought about", () => {
    render(<ThinkingChip value="low" agentEffort={null} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Thinking: Brief" })).toHaveTextContent(
      "Thinking · Brief",
    );
  });

  it("offers Auto, Off and the three levels, and hands back the one picked", () => {
    const onChange = vi.fn();
    render(<ThinkingChip value={null} agentEffort="medium" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Thinking: Auto" }), { key: "Enter" });
    const menu = screen.getByRole("menu");
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(names[0]).toBe("AutoThe agent's: Standard");
    expect(names.slice(1).map((n) => n?.split(/(?=[A-Z][a-z]+ )/)[0])).toEqual([
      "Off",
      expect.stringMatching(/^Brief/),
      expect.stringMatching(/^Standard/),
      expect.stringMatching(/^Extended/),
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Extended/ }));
    expect(onChange).toHaveBeenCalledWith("high");
  });
});

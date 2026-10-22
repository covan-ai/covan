import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AGENT_MARKS, AgentMark, AgentMarkPicker, agentMonogram, isAgentMark } from "./agent-mark";

describe("agentMonogram", () => {
  it("takes two letters from one word and the first of two words", () => {
    expect(agentMonogram("Support")).toBe("SU");
    expect(agentMonogram("Sales ops")).toBe("SO");
    expect(agentMonogram("  research  team lead ")).toBe("RT");
    expect(agentMonogram("")).toBe("–");
    expect(agentMonogram(null)).toBe("–");
  });
});

describe("AgentMark", () => {
  it("draws the mark on a white tile when the agent has one", () => {
    const { container } = render(<AgentMark agent={{ name: "Support", avatar: "headset" }} />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("falls back to the monogram, never an empty box", () => {
    for (const avatar of [null, undefined, "unicorn"]) {
      const { container, unmount } = render(<AgentMark agent={{ name: "Finance", avatar }} />);
      expect(container.querySelector("svg")).toBeNull();
      expect(container.textContent).toBe("FI");
      unmount();
    }
  });

  it("knows exactly the eight marks", () => {
    expect(AGENT_MARKS).toHaveLength(8);
    expect(isAgentMark("owl")).toBe(true);
    expect(isAgentMark("🦉")).toBe(false);
  });
});

describe("AgentMarkPicker", () => {
  it("is a radio group of the eight marks with the chosen one checked", () => {
    render(<AgentMarkPicker value="owl" onChange={() => {}} />);
    const group = screen.getByRole("radiogroup", { name: "Face" });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(8);
    expect(screen.getByRole("radio", { name: "Owl" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Fox" })).toHaveAttribute("aria-checked", "false");
  });

  it("picks on click and moves with the arrow keys", () => {
    const onChange = vi.fn();
    render(<AgentMarkPicker value="headset" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Bear" }));
    expect(onChange).toHaveBeenLastCalledWith("bear");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Headset" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("blob");
  });
});

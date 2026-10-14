import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TurnDial, type TurnDialProps } from "./turn-dial";

/**
 * The dial in the composer, on its own.
 *
 * What it owes the route is small and exact: show the value in force, offer
 * what means something on this model, and hand back a patch that says
 * precisely what changed — `null` where the choice was "the agent's". A patch
 * with the agent's model id in it instead of null would look identical today
 * and quietly stop following the agent the next time it moved, which is the
 * kind of thing only a test notices.
 *
 * Wrapped in a `TooltipProvider` because in the app it sits inside
 * `PromptInput`, which mounts the only one there is.
 *
 * Menus are opened from the keyboard, not with a click, and that is the test
 * as much as the harness: a control that only a pointer can open is DESIGN.md's
 * fifth failure mode.
 */
const open = (label: string) => fireEvent.keyDown(screen.getByLabelText(label), { key: "Enter" });
const pick = (el: HTMLElement) => fireEvent.click(el);

const specs = {
  "gpt-4.1": { temperature: true, reasoning: false, webSearch: false },
  "claude-opus-5": { temperature: false, reasoning: true, webSearch: true },
};

function renderDial(over: Partial<TurnDialProps> = {}) {
  const onChange = vi.fn();
  const props: TurnDialProps = {
    session: { kind: "chat", model: null, reasoningEffort: null, webSearch: null, mode: null },
    agent: { model: "gpt-4.1", reasoningEffort: null, webSearch: false, mode: "normal" },
    models: ["gpt-4.1", "claude-opus-5"],
    modelCosts: { "gpt-4.1": 0.008, "claude-opus-5": 0.03 },
    modelSpecs: specs,
    canTune: true,
    busy: false,
    compact: false,
    onChange,
    ...over,
  };
  render(
    <TooltipProvider>
      <TurnDial {...props} />
    </TooltipProvider>,
  );
  return onChange;
}

// A longer leash than the default five seconds. Each open menu is a Radix
// portal and a role query over it, and on a loaded laptop two of them in one
// test ran to seven seconds — slow, not stuck. The route's own test gives its
// heaviest case the same.
describe("the dial beside the question", { timeout: 20_000 }, () => {
  it("shows what the conversation is answered with, falling back to the agent's", () => {
    renderDial({
      session: {
        kind: "chat",
        model: "claude-opus-5",
        reasoningEffort: "high",
        webSearch: null,
        mode: null,
      },
      agent: { model: "gpt-4.1", reasoningEffort: null, webSearch: true, mode: "brainstorm" },
    });

    expect(screen.getByLabelText("Model: claude-opus-5")).toBeInTheDocument();
    expect(screen.getByLabelText("Thinking: High")).toBeInTheDocument();
    expect(screen.getByLabelText("Web search: On")).toBeInTheDocument();
    expect(screen.getByLabelText("Mode: Brainstorm")).toBeInTheDocument();
  });

  it("offers no thinking control on a model that does not reason", () => {
    renderDial({
      session: { kind: "chat", model: null, reasoningEffort: "high", webSearch: null, mode: null },
    });

    expect(screen.getByLabelText("Model: gpt-4.1")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Thinking/)).not.toBeInTheDocument();
  });

  it("says Auto when neither the conversation nor the agent chose an effort", () => {
    renderDial({
      agent: { model: "claude-opus-5", reasoningEffort: null, webSearch: false, mode: "normal" },
    });

    expect(screen.getByLabelText("Thinking: Auto")).toBeInTheDocument();
  });

  it("hands back the model picked, with its price beside it in the menu", () => {
    const onChange = renderDial();

    open("Model: gpt-4.1");
    expect(screen.getByText("$0.030")).toBeInTheDocument();
    pick(screen.getByText("claude-opus-5"));

    expect(onChange).toHaveBeenCalledWith({ model: "claude-opus-5" });
  });

  it("stores null, not the id, when the agent's own model is picked back", () => {
    const onChange = renderDial({
      session: {
        kind: "chat",
        model: "claude-opus-5",
        reasoningEffort: null,
        webSearch: null,
        mode: null,
      },
    });

    open("Model: claude-opus-5");
    expect(screen.getByText("(agent's)")).toBeInTheDocument();
    pick(screen.getByText("gpt-4.1"));

    expect(onChange).toHaveBeenCalledWith({ model: null });
  });

  it("spells thinking off as the minimal effort, and a level as itself", () => {
    const onChange = renderDial({
      agent: {
        model: "claude-opus-5",
        reasoningEffort: "medium",
        webSearch: false,
        mode: "normal",
      },
    });

    open("Thinking: Medium");
    pick(screen.getByRole("menuitemcheckbox", { name: "Off" }));
    expect(onChange).toHaveBeenLastCalledWith({ reasoningEffort: "minimal" });

    open("Thinking: Medium");
    pick(screen.getByRole("menuitemcheckbox", { name: /^High/ }));
    expect(onChange).toHaveBeenLastCalledWith({ reasoningEffort: "high" });
  });

  it("goes back to the agent's with null, and says what the agent's is", () => {
    const onChange = renderDial({
      session: { kind: "chat", model: null, reasoningEffort: null, webSearch: true, mode: null },
    });

    open("Web search: On");
    expect(screen.getByText("(agent's: Off)")).toBeInTheDocument();
    pick(screen.getByRole("menuitemcheckbox", { name: /Auto/ }));

    expect(onChange).toHaveBeenCalledWith({ webSearch: null });
  });

  it("writes nothing when the value in force is picked again", () => {
    const onChange = renderDial();

    open("Web search: Off");
    pick(screen.getByRole("menuitemcheckbox", { name: /Auto/ }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("says brainstorm rather than offering it in a brainstorm conversation", () => {
    renderDial({
      session: {
        kind: "brainstorm",
        model: null,
        reasoningEffort: null,
        webSearch: null,
        mode: null,
      },
    });

    expect(screen.getByText("Brainstorm")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Mode:/)).not.toBeInTheDocument();
  });

  it("is a reading, not a control, for somebody who does not own the conversation", () => {
    const onChange = renderDial({ canTune: false });

    const model = screen.getByLabelText("Model: gpt-4.1");
    expect(model).toHaveAttribute("aria-disabled", "true");
    expect(model).not.toHaveAttribute("aria-haspopup");
    fireEvent.keyDown(model, { key: "Enter" });
    fireEvent.click(model);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("waits for a running reply rather than changing under it", () => {
    const onChange = renderDial({ busy: true });

    const web = screen.getByLabelText("Web search: Off");
    expect(web).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(web, { key: "Enter" });
    fireEvent.click(web);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the values and drops the words on a phone", () => {
    renderDial({ compact: true });

    expect(screen.getByLabelText("Web search: Off")).toHaveTextContent(/^Off$/);
  });
});

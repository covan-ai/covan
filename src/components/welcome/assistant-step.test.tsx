import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistantStep } from "./assistant-step";

function renderStep(onSubmit = vi.fn()) {
  render(
    <>
      <AssistantStep
        formId="f"
        workspaceName="Acme"
        value={{ assistantName: null }}
        onSubmit={onSubmit}
      />
      <button type="submit" form="f">
        Create
      </button>
    </>,
  );
  return onSubmit;
}

describe("AssistantStep", () => {
  it("writes the persona from the jobs picked, until somebody edits it", async () => {
    renderStep();
    const persona = screen.getByLabelText("Persona");
    expect((persona as HTMLTextAreaElement).value).toContain(
      "answer customer questions using the documents in Knowledge",
    );

    await userEvent.click(screen.getByRole("button", { name: "Research the web" }));
    expect((persona as HTMLTextAreaElement).value).toContain("research questions on the web");

    await userEvent.clear(persona);
    await userEvent.type(persona, "Mine.");
    await userEvent.click(screen.getByRole("button", { name: "Reconcile numbers" }));
    expect(persona).toHaveValue("Mine.");

    await userEvent.click(screen.getByRole("button", { name: "Rewrite" }));
    expect((persona as HTMLTextAreaElement).value).toContain("check figures against each other");
  });

  it("shows the agent as the sidebar will", async () => {
    renderStep();
    await userEvent.type(screen.getByLabelText("Name"), "Support");
    expect(screen.getByText("In the sidebar")).toBeInTheDocument();
    expect(screen.getByText("Only you can use it until you share it.")).toBeInTheDocument();
  });

  it("hands back the name, the mark, the jobs and the persona", async () => {
    const onSubmit = renderStep();
    await userEvent.type(screen.getByLabelText("Name"), "Support");
    await userEvent.click(screen.getByRole("radio", { name: /fox/i }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onSubmit).toHaveBeenCalledWith({
      assistantName: "Support",
      assistantAvatar: "fox",
      assistantJobs: ["answer-questions"],
      persona: expect.stringContaining("You work for Acme."),
    });
  });

  it("will not go on without a name", async () => {
    const onSubmit = renderStep();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

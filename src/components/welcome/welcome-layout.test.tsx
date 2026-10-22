import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomeLayout } from "./welcome-layout";

describe("WelcomeLayout", () => {
  it("says which of the three steps this is, with Save and exit beside it", async () => {
    const onExit = vi.fn();
    render(
      <WelcomeLayout
        progress={{ index: 1, count: 3 }}
        stepKey="assistant"
        title="Set up your first agent"
        primary={{ label: "Create Support" }}
        back={{ label: "Back", onClick: vi.fn() }}
        onExit={onExit}
        below="Next: add the first documents it should know."
      >
        <p>body</p>
      </WelcomeLayout>,
    );
    expect(screen.getByRole("status", { name: "Step 2 of 3" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set up your first agent" })).toBeInTheDocument();
    expect(screen.getByText("Next: add the first documents it should know.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save and exit" }));
    expect(onExit).toHaveBeenCalled();
  });

  it("counts nothing outside the three steps", () => {
    render(
      <WelcomeLayout
        progress={null}
        stepKey="invite-accept"
        title="You've been invited"
        primary={null}
      >
        <p>body</p>
      </WelcomeLayout>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

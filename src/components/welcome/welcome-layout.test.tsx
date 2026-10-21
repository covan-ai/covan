import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomeLayout } from "./welcome-layout";
import type { Progress } from "@/lib/onboarding-flow";

const progress: Progress = {
  index: 5,
  count: 8,
  sections: [
    { id: "meet", label: "Meet", state: "done", dots: ["done", "done", "done", "done"] },
    {
      id: "personalise",
      label: "Personalise",
      state: "current",
      dots: ["done", "current", "todo", "todo"],
    },
    { id: "start", label: "Start", state: "todo", dots: [] },
  ],
};

describe("WelcomeLayout", () => {
  it("names the three parts and says where in the run this is", () => {
    render(
      <WelcomeLayout progress={progress} stepKey="tools" primary={{ label: "Continue" }} title="T">
        body
      </WelcomeLayout>,
    );

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "6");
    expect(bar).toHaveAttribute("aria-valuemax", "8");
    expect(screen.getByText("Meet")).toBeInTheDocument();
    expect(screen.getByText("Personalise")).toBeInTheDocument();
    expect(screen.getByText("Start")).toBeInTheDocument();
  });

  it("has no way back on the first screen, and the three places on every other", async () => {
    const back = vi.fn();
    const skip = vi.fn();
    const primary = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <WelcomeLayout
        progress={progress}
        stepKey="a"
        back={null}
        primary={{ label: "Continue", onClick: primary }}
      >
        body
      </WelcomeLayout>,
    );
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();

    rerender(
      <WelcomeLayout
        progress={progress}
        stepKey="b"
        back={{ label: "Back", onClick: back }}
        skip={{ label: "Skip intro", onClick: skip }}
        primary={{ label: "Continue", onClick: primary }}
      >
        body
      </WelcomeLayout>,
    );
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Skip intro" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(back).toHaveBeenCalled();
    expect(skip).toHaveBeenCalled();
    expect(primary).toHaveBeenCalled();
  });

  it("submits the screen's form from the bar, so Enter in the form advances too", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const user = userEvent.setup();
    render(
      <WelcomeLayout progress={progress} stepKey="c" formId="f" primary={{ label: "Continue" }}>
        <form id="f" onSubmit={onSubmit}>
          <input aria-label="Name" />
        </form>
      </WelcomeLayout>,
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText("Name"), "x{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});

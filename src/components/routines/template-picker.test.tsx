import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TemplatePicker } from "./template-picker";
import { templateById, type TemplateFacts } from "@/lib/routine-templates";

const ready: TemplateFacts = {
  agentDocumentCount: 2,
  isAdmin: true,
  gapReportEnabled: true,
  memberCount: 5,
};

describe("the template picker", () => {
  it("offers every template by name", () => {
    render(<TemplatePicker facts={ready} onPick={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Somebody's first week/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /What nobody wrote down/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Weekly digest of a feed/ })).toBeInTheDocument();
  });

  it("hands the whole template back when one is picked", async () => {
    // Not `weekly-digest`: the adjudication pass gives it a permanent
    // `feedUrl` requirement (the dialog has no input for `sourceUrl` right
    // now), so its card is disabled under every `TemplateFacts` — see the
    // dedicated test below for that. `first-week` has no such gap.
    const onPick = vi.fn();
    render(<TemplatePicker facts={ready} onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: /Somebody's first week/ }));
    expect(onPick).toHaveBeenCalledWith(templateById("first-week"));
  });

  it("explains the weekly digest's missing url field instead of offering a dead end", () => {
    render(<TemplatePicker facts={ready} onPick={vi.fn()} />);
    const card = screen.getByRole("button", { name: /Weekly digest of a feed/ });
    expect(card).toBeDisabled();
    expect(screen.getByText(/place to enter the feed's URL/)).toBeInTheDocument();
  });

  /**
   * Shows the reason, keeps the card. Hiding it means nobody ever learns the
   * report exists, and "an admin can turn this on" is a useful sentence.
   */
  it("explains an unmet requirement instead of hiding the template", () => {
    render(<TemplatePicker facts={{ ...ready, gapReportEnabled: false }} onPick={vi.fn()} />);
    const card = screen.getByRole("button", { name: /What nobody wrote down/ });
    expect(card).toBeDisabled();
    expect(screen.getByText(/turn the coverage report on/)).toBeInTheDocument();
  });

  it("cannot be picked while a requirement is unmet", async () => {
    const onPick = vi.fn();
    render(<TemplatePicker facts={{ ...ready, agentDocumentCount: 0 }} onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: /Somebody's first week/ }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("gives only the first unmet reason, so the card stays one sentence", () => {
    render(
      <TemplatePicker
        facts={{ ...ready, isAdmin: false, gapReportEnabled: false, memberCount: 1 }}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByText(/Only an admin of this workspace/)).toBeInTheDocument();
    expect(screen.queryByText(/turn the coverage report on/)).not.toBeInTheDocument();
  });
});

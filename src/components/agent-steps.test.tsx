import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmCard, SettledSteps, StepTrail, toStepViews } from "./agent-steps";

/**
 * What an answer did, and the card that stops it doing something nobody
 * agreed to.
 *
 * Several of the assertions here are about `DESIGN.md` rather than about
 * behaviour, and they are the ones worth keeping: a chip is never destructive,
 * so a failed step carries its failure at the row level; the marks are squares
 * rather than circles; and the two ambers on this screen — the step that is
 * running and the confirmation waiting on somebody — are told apart by SHAPE,
 * so that the distinction survives with animation switched off.
 */

const step = (over: Partial<Parameters<typeof toStepViews>[0][number]> = {}) => ({
  index: 0,
  tool: "query_database",
  status: "ok" as const,
  request: { sql: "select count(*) from orders" },
  ...over,
});

describe("toStepViews", () => {
  it("labels a step with what it was pointed at, not only which tool ran", () => {
    expect(toStepViews([step()])[0].label).toBe("query_database · select count(*) from orders");
  });

  it("falls back to the tool's name when the arguments say nothing readable", () => {
    expect(toStepViews([step({ request: { limit: 5 } })])[0].label).toBe("query_database");
  });

  it("collapses whitespace, because SQL arrives with newlines in it", () => {
    const view = toStepViews([step({ request: { sql: "select 1\n  from orders" } })])[0];
    expect(view.label).toBe("query_database · select 1 from orders");
  });

  it("survives a request that is not an object at all", () => {
    expect(toStepViews([step({ request: null })])[0].label).toBe("query_database");
  });
});

describe("the live trail", () => {
  it("says what is happening, one row per step", () => {
    render(
      <StepTrail
        steps={[
          { index: 0, tool: "search_documents", status: "ok", label: "search_documents · leave" },
          { index: 1, tool: "query_database", status: "running", label: "query_database · orders" },
        ]}
      />,
    );
    expect(screen.getByText("search_documents · leave")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("marks a running step with a square, not a spinning circle", () => {
    // `DESIGN.md` allows circles in two places and both are window chrome.
    // This was lucide's `Loader2`, which was neither — and said "busy" in
    // general where the trail's whole job is saying which row.
    const { container } = render(
      <StepTrail steps={[{ index: 0, tool: "a", status: "running", label: "a" }]} />,
    );
    expect(container.querySelector(".step-running")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
  });

  it("gives the two ambers different shapes, not different animations", () => {
    // A waiting step is a FILLED amber square: this one is yours. A running
    // step is an amber OUTLINE with the fill sweeping through it: the machine
    // is busy and nothing is being asked. The sweep is the only animated part,
    // so a reader with motion switched off still has outline against fill —
    // rather than two identical squares, one of which was moving.
    const { container: waiting } = render(
      <StepTrail steps={[{ index: 0, tool: "a", status: "pending", label: "a" }]} />,
    );
    const { container: busy } = render(
      <StepTrail steps={[{ index: 0, tool: "a", status: "running", label: "a" }]} />,
    );

    expect(waiting.querySelector(".bg-accent-orange")).toBeInTheDocument();
    expect(busy.querySelector(".bg-accent-orange")).not.toBeInTheDocument();
  });

  it("draws nothing at all when there are no steps", () => {
    const { container } = render(<StepTrail steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the settled trail", () => {
  it("is folded shut, and says how many and how many did not finish", () => {
    render(
      <SettledSteps
        steps={[
          { index: 0, tool: "a", status: "ok", label: "a" },
          { index: 1, tool: "b", status: "failed", label: "b" },
        ]}
      />,
    );
    expect(screen.getByText("2 steps · 1 did not complete")).toBeInTheDocument();
    // Closed: a person checking an answer opens it, and everybody else reads
    // the reply.
    expect(screen.queryByRole("group")).not.toHaveAttribute("open");
  });

  it('counts one step in the singular, because "1 steps" is a bug people notice', () => {
    render(<SettledSteps steps={[{ index: 0, tool: "a", status: "ok", label: "a" }]} />);
    expect(screen.getByText("1 step")).toBeInTheDocument();
  });
});

describe("the confirmation card", () => {
  const pending = {
    id: "p1",
    tool: "schedule_job",
    summary: 'Create a routine "Monday orders" on 0 17 * * 1?',
    proposal: {
      kind: "schedule_job",
      name: "Monday orders",
      cron: "0 17 * * 1",
      firstRunAt: "2026-09-22T14:00:00.000Z",
    },
  };

  it("prints the proposal as rows, whatever the tool put in it", () => {
    render(<ConfirmCard pending={pending} busy={false} onAnswer={() => {}} />);
    expect(screen.getByText("Monday orders")).toBeInTheDocument();
    expect(screen.getByText("0 17 * * 1")).toBeInTheDocument();
    // `kind` is how the worker tags the proposal for itself; the card already
    // names the tool, so printing it again is a row that says nothing.
    expect(screen.queryByText("kind")).not.toBeInTheDocument();
  });

  it("says plainly that nothing has happened yet", () => {
    render(<ConfirmCard pending={pending} busy={false} onAnswer={() => {}} />);
    expect(screen.getByText(/nothing happens until you say so/)).toBeInTheDocument();
  });

  /**
   * "Not now" is not a dismissal. It goes to the same endpoint with
   * `approve: false`, so the agent is told and can finish its turn — closing
   * the card locally would leave the conversation ending mid-sentence.
   */
  it("reports both answers to the caller", async () => {
    const onAnswer = vi.fn();
    render(<ConfirmCard pending={pending} busy={false} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onAnswer.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it("cannot be answered twice while the first answer is in flight", () => {
    render(<ConfirmCard pending={pending} busy onAnswer={() => {}} />);
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeDisabled();
  });

  /**
   * The highest-stakes surface in the product, and the one place a nested
   * object actually appears. Until `run_tool` every proposal was flat, so
   * one-line `JSON.stringify` was an honest rendering of the worst case — and
   * the body of an email printed that way is a blob nobody reads on the screen
   * where they are being asked to approve sending it.
   */
  it("opens up a nested object rather than printing it as JSON", () => {
    render(
      <ConfirmCard
        pending={{
          id: "p3",
          tool: "run_tool",
          summary: "Run GMAIL_SEND_EMAIL on Ana's Gmail?",
          proposal: {
            kind: "run_tool",
            slug: "GMAIL_SEND_EMAIL",
            arguments: {
              recipient_email: "ana@example.com",
              body: "Hi Ana,\n\nThe orders report is attached.",
            },
          },
        }}
        busy={false}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByText("ana@example.com")).toBeInTheDocument();
    expect(screen.getByText(/The orders report is attached/)).toBeInTheDocument();
    expect(screen.getByText("recipient email")).toBeInTheDocument();
    // One level, and no more: two would invite an approval card that scrolls.
    expect(screen.queryByText(/^\{"recipient_email"/)).not.toBeInTheDocument();
  });

  /**
   * The third action, and where it sits.
   *
   * It is a prop rather than something the card works out, because working it
   * out would mean knowing which tools have a standing permission to grant —
   * and this card's whole discipline is that it knows about none of them.
   */
  it("offers no standing permission unless the caller says there is one", () => {
    render(<ConfirmCard pending={pending} busy={false} onAnswer={() => {}} />);
    expect(screen.queryByRole("button", { name: "Always allow this" })).not.toBeInTheDocument();
  });

  it("puts the standing permission last, and reports it to the caller", async () => {
    const onChoose = vi.fn();
    render(
      <ConfirmCard
        pending={pending}
        busy={false}
        onAnswer={() => {}}
        standing={{ label: "Always allow this", onChoose }}
      />,
    );
    // Accessible names rather than `textContent`: the primary variant renders
    // its label twice for the roller animation (`ui/button.tsx`), so the text
    // of that one node is "ApproveApprove" and always has been.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    // Last and quietest of the three: the safe answer should be the easy one,
    // and "never ask me again" where the eye lands first is how people end up
    // with permissions they do not remember giving.
    expect(buttons[0]).toHaveAccessibleName("Approve");
    expect(buttons[2]).toHaveAccessibleName("Always allow this");

    await userEvent.click(screen.getByRole("button", { name: "Always allow this" }));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("says a yes does not cover anything that changes data, because it does not", async () => {
    // `run-tool.ts` stopped letting a connection's approval cover a destructive
    // operation in #202, and this sentence was left behind claiming it still
    // did — telling somebody they had granted more than they had, on the card
    // where they were deciding. The words are asserted rather than the shape
    // because the words are the whole feature.
    render(
      <ConfirmCard
        pending={pending}
        busy={false}
        onAnswer={() => {}}
        standing={{ label: "Always allow this", onChoose: () => {} }}
      />,
    );
    const note = screen.getByText(/Approving covers this service/);
    expect(note).toHaveTextContent("except for anything that changes data there");
    expect(note).toHaveTextContent("asks again each time");
  });

  it("still draws something when a tool proposed nothing structured", () => {
    render(
      <ConfirmCard
        pending={{ id: "p2", tool: "send_email", summary: "Send it?", proposal: null }}
        busy={false}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByText("Send it?")).toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ConfirmCard,
  SettledSteps,
  StepTrail,
  toStepViews,
  type AgentStepView,
} from "./agent-steps";

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

  it("says how long the work took, when the steps recorded it", () => {
    // The number was already in `message_steps` and was being dropped on the
    // way to the screen. A folded line that says only "3 steps" answers a
    // question nobody asked; the one people actually have about a pause is how
    // long it was.
    render(
      <SettledSteps
        steps={[
          { index: 0, tool: "a", status: "ok", label: "a", durationMs: 800 },
          { index: 1, tool: "b", status: "ok", label: "b", durationMs: 1400 },
        ]}
      />,
    );
    expect(screen.getByText("2 steps · 2.2s")).toBeInTheDocument();
  });

  it("says nothing about duration for steps written before it was stored", () => {
    // `durationMs` is null on every step recorded before the column existed,
    // and "0.0s" would be a measurement rather than a missing one.
    render(
      <SettledSteps
        steps={[{ index: 0, tool: "a", status: "ok", label: "a", durationMs: null }]}
      />,
    );
    expect(screen.getByText("1 step")).toBeInTheDocument();
  });

  it("still leads with what went wrong when something did", () => {
    render(
      <SettledSteps
        steps={[
          { index: 0, tool: "a", status: "ok", label: "a", durationMs: 500 },
          { index: 1, tool: "b", status: "failed", label: "b", durationMs: 500 },
        ]}
      />,
    );
    expect(screen.getByText("2 steps · 1.0s · 1 did not complete")).toBeInTheDocument();
  });
});

describe("a step arriving", () => {
  it("slides in, with the offset only in the keyframe", () => {
    // `prefers-reduced-motion` switches the animation off and leaves the
    // element in its BASE state. A class whose base declaration carries the
    // translate would leave every row permanently four pixels out of place for
    // the readers who asked for less movement — the opposite of the favour.
    const { container } = render(
      <StepTrail steps={[{ index: 0, tool: "a", status: "running", label: "a" }]} />,
    );
    const row = container.querySelector("li");
    expect(row).toHaveClass("step-arrive");
    expect(row?.getAttribute("style") ?? "").not.toContain("transform");
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

/**
 * The payload, carried rather than discarded.
 *
 * `toStepViews` built its one-line label out of `request` and then dropped
 * both `request` and `resultExcerpt` on the floor, so the panel in §1 of the
 * design had nothing to open onto. The label is unchanged — it is kept
 * byte-identical with `labelFor` in the worker's harness loop — and the two
 * fields now travel beside it.
 */
describe("toStepViews payloads", () => {
  it("carries the request through, not only the label built from it", () => {
    const view = toStepViews([step()])[0];
    expect(view.request).toEqual({ sql: "select count(*) from orders" });
  });

  it("carries the result excerpt through", () => {
    const view = toStepViews([step({ resultExcerpt: "41 orders." })])[0];
    expect(view.resultExcerpt).toBe("41 orders.");
  });

  it("reports no excerpt as null, for a step stored before 0060", () => {
    expect(toStepViews([step()])[0].resultExcerpt).toBeNull();
  });

  it("still builds the same label it always did", () => {
    const view = toStepViews([step({ resultExcerpt: "41 orders." })])[0];
    expect(view.label).toBe("query_database · select count(*) from orders");
  });
});

/**
 * The panel under a settled row.
 *
 * `message_steps` has held both halves of this since 0060 — the arguments the
 * tool was handed and the first part of what it gave back — and the trail drew
 * an 80-character label and threw the rest away. For a step that failed or was
 * refused, this panel is the only place on the screen where the reason is
 * readable at all.
 */
describe("the tool panel", () => {
  const settled = (over: Partial<AgentStepView> = {}): AgentStepView => ({
    index: 0,
    tool: "query_database",
    status: "ok",
    label: "query_database · select count(*) from orders",
    request: { sql: "select count(*) from orders" },
    resultExcerpt: "41 orders.",
    ...over,
  });

  it("opens a row that carries a payload, and closes it again", async () => {
    render(<StepTrail steps={[settled()]} />);
    const row = screen.getByRole("button");

    expect(screen.queryByText("Sent")).not.toBeInTheDocument();

    await userEvent.click(row);
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Returned")).toBeInTheDocument();
    expect(screen.getByText(/41 orders\./)).toBeInTheDocument();

    await userEvent.click(row);
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
  });

  it("draws Sent alone for a step stored before the excerpt was", async () => {
    // An empty Returned block would say the tool returned nothing, which is a
    // different claim from not having recorded what it returned.
    render(<StepTrail steps={[settled({ resultExcerpt: null })]} />);

    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.queryByText("Returned")).not.toBeInTheDocument();
  });

  it("puts a refusal's reason somewhere a person can reach it", async () => {
    render(
      <StepTrail
        steps={[
          settled({
            status: "refused",
            resultExcerpt: "Sending mail from this connection needs an approval.",
          }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/needs an approval/)).toBeInTheDocument();
    // Not under a heading that reads as routine output.
    expect(screen.getByText("Why it was not allowed")).toBeInTheDocument();
  });

  it("does not call a question somebody is being asked a result", async () => {
    /*
     * `loop.ts` stores a confirmation pause as `status: "pending"` with the
     * PROPOSAL's summary in `result_excerpt` — the question, not a result. A
     * confirmation nobody ever answers stays `pending` in the stored
     * transcript, so "Returned" over that text is the screen stating something
     * untrue about what happened, on the one surface where somebody is being
     * asked to approve sending something.
     */
    render(
      <StepTrail
        steps={[
          settled({
            status: "pending",
            resultExcerpt: "Send an email to ana@example.com about the Q3 numbers?",
          }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/about the Q3 numbers/)).toBeInTheDocument();
    expect(screen.queryByText("Returned")).not.toBeInTheDocument();
    expect(screen.getByText("What it is asking")).toBeInTheDocument();
  });

  it("does not animate the panel for a reader who asked for less movement", () => {
    const { container } = render(<StepTrail steps={[settled()]} />);
    expect(container.querySelector("[data-state]")).toBeInTheDocument();
    expect(container.innerHTML).toContain("motion-reduce:animate-none");
  });

  it("leaves a running row alone, because a live step carries no payload", () => {
    // `HarnessEvent`'s `step` variant is `{ index, tool, status, label }`.
    // Widening it would put every tool call's arguments into the SSE stream of
    // every open browser on every turn, to buy the seconds before it settles.
    render(<StepTrail steps={[{ index: 0, tool: "a", status: "running", label: "a" }]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("leaves a settled row alone when there is nothing behind it", () => {
    // `mapSteps` writes `request: {}` for a row that stored none, and every
    // row written before 0060 has no excerpt. A fold onto nothing is worse
    // than no fold.
    render(<StepTrail steps={[settled({ request: {}, resultExcerpt: null })]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

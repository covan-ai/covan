import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutineOutputCard } from "./routine-output-card";
import type { Routine } from "@/lib/routines-api";

const routine: Routine = {
  id: "r1",
  agentId: "a1",
  userId: "me",
  name: "Competitor digest",
  visibility: "private",
  sourceKind: "rss",
  sourceUrl: "https://example.com/feed.xml",
  connectionId: null,
  instruction: "summarise",
  deliveryChannelId: "c1",
  scheduleCron: "0 9 * * 1",
  timezone: "UTC",
  triggerKind: "schedule",
  outputBundleId: null,
  outputRetention: 52,
  status: "active",
  pausedReason: null,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: 0,
};

const bundles = [
  { id: "b1", name: "Competitors" },
  { id: "b2", name: "Handbook" },
];

const props = {
  routine,
  bundles,
  attachedBundleIds: [] as string[],
  canWrite: true,
  onSave: () => {},
  saving: false,
};

describe("RoutineOutputCard", () => {
  it("says what happens when it keeps nothing, which is the default", () => {
    render(<RoutineOutputCard {...props} />);
    expect(screen.getByText(/delivered and then forgotten/)).toBeInTheDocument();
    // No retention control, because there is nothing to retain. A disabled
    // number beside "Keep nothing" would be a setting that does nothing.
    expect(screen.queryByLabelText("Keep the last")).not.toBeInTheDocument();
  });

  it("names the bundle it files into and how many it keeps", () => {
    render(
      <RoutineOutputCard
        {...props}
        routine={{ ...routine, outputBundleId: "b1", outputRetention: 12 }}
      />,
    );
    // Read off the sentence rather than off the screen: the bundle's name is
    // also the Select's own value, so asking whether "Competitors" is anywhere
    // finds two nodes and says nothing about either.
    const sentence = screen.getByText(/files one document into/);
    expect(sentence).toHaveTextContent("Competitors");
    expect(sentence).toHaveTextContent("more than 12");
  });

  it("starts filing into the bundle that was picked", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<RoutineOutputCard {...props} onSave={onSave} />);

    await user.click(screen.getByLabelText("Bundle"));
    await user.click(await screen.findByRole("option", { name: "Handbook" }));

    expect(onSave).toHaveBeenCalledWith({ outputBundleId: "b2" });
  });

  it("stops filing with a null rather than by omission", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <RoutineOutputCard
        {...props}
        routine={{ ...routine, outputBundleId: "b1" }}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByLabelText("Bundle"));
    await user.click(await screen.findByRole("option", { name: "Keep nothing" }));

    // Absent would mean "leave filing alone" to the API, which is the opposite
    // of what this control was just used for.
    expect(onSave).toHaveBeenCalledWith({ outputBundleId: null });
  });

  // The one arrangement in which a routine reads its own output back. Said
  // rather than prevented: it is usually the point.
  it("says so when the agent also reads what this routine writes", () => {
    render(
      <RoutineOutputCard
        {...props}
        routine={{ ...routine, outputBundleId: "b1" }}
        attachedBundleIds={["b1"]}
      />,
    );
    expect(screen.getByText(/later runs will read what earlier ones wrote/)).toBeInTheDocument();
  });

  // DESIGN.md's first failure mode is a claim the code cannot back, and
  // "every run files one document" is exactly that for somebody whose runs
  // will file nothing. The database lets a viewer set the column and the
  // engine refuses at run time, so the honest thing is to say so here rather
  // than to hide the control or to let them find out from a run note a week
  // later.
  it("does not promise a viewer something their runs will not do", () => {
    render(
      <RoutineOutputCard
        {...props}
        routine={{ ...routine, outputBundleId: "b1" }}
        canWrite={false}
      />,
    );
    expect(screen.getByText(/nothing is filed/)).toBeInTheDocument();
    expect(screen.queryByText(/files one document into/)).not.toBeInTheDocument();
  });

  it("stays quiet when the bundle is not one the agent reads", () => {
    render(
      <RoutineOutputCard
        {...props}
        routine={{ ...routine, outputBundleId: "b1" }}
        attachedBundleIds={["b2"]}
      />,
    );
    expect(screen.queryByText(/later runs will read/)).not.toBeInTheDocument();
  });
});

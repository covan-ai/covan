import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditRoutineDialog } from "./edit-routine-dialog";
import type { Routine, DeliveryChannel } from "@/lib/routines-api";

const routine: Routine = {
  id: "r1",
  agentId: "a1",
  userId: "u1",
  name: "Competitor watch",
  visibility: "private",
  sourceKind: "rss",
  sourceUrl: "https://example.com/feed.xml",
  instruction: "Summarise anything about pricing.",
  deliveryChannelId: "c1",
  scheduleCron: "0 */6 * * *",
  timezone: "Europe/Istanbul",
  status: "active",
  pausedReason: null,
  nextRunAt: Date.now() + 60_000,
  lastRunAt: null,
  createdAt: Date.now(),
};

const channels: DeliveryChannel[] = [
  { id: "c1", kind: "email", label: "e••@example.com", createdAt: Date.now() },
];

async function open(onSave = vi.fn()) {
  const user = userEvent.setup();
  render(
    <EditRoutineDialog routine={routine} channels={channels} onSave={onSave} saving={false} />,
  );
  await user.click(screen.getByRole("button", { name: /^edit$/i }));
  return { user, onSave };
}

describe("EditRoutineDialog", () => {
  it("opens with the routine's current values", async () => {
    await open();
    expect(screen.getByLabelText(/^name$/i)).toHaveValue("Competitor watch");
    expect(screen.getByLabelText(/instruction/i)).toHaveValue("Summarise anything about pricing.");
    expect(screen.getByLabelText(/hours between runs/i)).toHaveValue(6);
    expect(screen.getByLabelText(/time zone/i)).toHaveValue("Europe/Istanbul");
  });

  // Sending an unchanged schedule is not free: the PATCH handler recomputes
  // next_run_at whenever the schedule is present, so a rename would silently
  // reschedule the routine.
  it("sends only the fields that changed", async () => {
    const { user, onSave } = await open();

    await user.clear(screen.getByLabelText(/^name$/i));
    await user.type(screen.getByLabelText(/^name$/i), "Pricing watch");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith({ name: "Pricing watch" });
  });

  it("saves a new schedule as a cron expression", async () => {
    const { user, onSave } = await open();

    await user.clear(screen.getByLabelText(/hours between runs/i));
    await user.type(screen.getByLabelText(/hours between runs/i), "2");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith({ scheduleCron: "0 */2 * * *" });
  });

  it("will not save an interval the engine cannot honour", async () => {
    const { user, onSave } = await open();

    await user.clear(screen.getByLabelText(/hours between runs/i));
    await user.type(screen.getByLabelText(/hours between runs/i), "0");

    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does nothing when nothing changed", async () => {
    const { user, onSave } = await open();
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  // The cursor records how far this routine has read *this* source. Repointing
  // it would diff a new feed against the old feed's seen keys, so the PATCH
  // endpoint does not accept a source at all — say so rather than leaving the
  // user hunting for a field that was never there.
  it("shows the source as fixed, with the reason", async () => {
    await open();
    expect(screen.getByText("https://example.com/feed.xml")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /url/i })).toBeNull();
    expect(screen.getByText(/delete it and make a new one/i)).toBeInTheDocument();
  });
});

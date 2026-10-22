import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SchedulePicker, scheduleError } from "./schedule-picker";

// The mode <Select> is Radix, whose popover needs browser APIs jsdom does not
// provide. Every mode is reachable without it, because the picker seeds its
// mode from the cron it is given — so each test starts in the mode it exercises.

describe("SchedulePicker", () => {
  it("says the schedule in words, with its cron beside it (A28)", () => {
    render(<SchedulePicker value="0 */6 * * *" onChange={vi.fn()} />);
    expect(screen.getByText("Every 6 hours")).toBeInTheDocument();
    expect(screen.getByText("0 */6 * * *")).toBeInTheDocument();
  });

  it("picks days of the week, Monday first", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SchedulePicker value="30 8 * * 1" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Thu" }));
    expect(onChange).toHaveBeenLastCalledWith("30 8 * * 1,4");
  });

  it("emits an hourly cron when the hour count changes", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SchedulePicker value="0 * * * *" onChange={onChange} />);

    const field = screen.getByLabelText(/hours between runs/i);
    await user.clear(field);
    await user.type(field, "3");

    expect(onChange).toHaveBeenLastCalledWith("0 */3 * * *");
  });

  it("emits a daily cron when the time changes", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SchedulePicker value="0 9 * * *" onChange={onChange} />);

    await user.clear(screen.getByLabelText(/time of day/i));
    await user.type(screen.getByLabelText(/time of day/i), "08:30");

    expect(onChange).toHaveBeenLastCalledWith("30 8 * * *");
  });

  it("emits an empty schedule while a field is mid-edit, so the save is blocked", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SchedulePicker value="*/15 * * * *" onChange={onChange} />);

    await user.clear(screen.getByLabelText(/minutes between runs/i));

    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("explains the floor instead of silently correcting an interval below it", () => {
    render(<SchedulePicker value="*/1 * * * *" onChange={vi.fn()} />);
    expect(screen.getByText(/shortest interval it can honour/i)).toBeInTheDocument();
  });

  it("refuses a minute interval cron cannot express", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SchedulePicker value="*/15 * * * *" onChange={onChange} />);

    const field = screen.getByLabelText(/minutes between runs/i);
    await user.clear(field);
    await user.type(field, "60");

    // "" is how this component reports an unfinished or unusable field, and it
    // is what blocks the save. `*/60 * * * *` would have been accepted by the
    // server and quietly meant "hourly".
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("still accepts the largest expressible interval", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SchedulePicker value="*/15 * * * *" onChange={onChange} />);

    const field = screen.getByLabelText(/minutes between runs/i);
    await user.clear(field);
    await user.type(field, "59");

    expect(onChange).toHaveBeenLastCalledWith("*/59 * * * *");
  });

  // The draft parser emits `0 9 * * 1-5` for "every weekday", and editing one
  // used to open on "every 1 hours".
  it("opens a weekday schedule on its own time, and keeps it weekdays", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SchedulePicker value="0 9 * * 1-5" onChange={onChange} />);

    expect(screen.getByLabelText(/time of day/i)).toHaveValue("09:00");
    await user.clear(screen.getByLabelText(/time of day/i));
    await user.type(screen.getByLabelText(/time of day/i), "08:30");
    expect(onChange).toHaveBeenLastCalledWith("30 8 * * 1-5");
  });

  // Routines created before this picker existed carry whatever they were made
  // with. Rounding those to the nearest shape the picker knows would change a
  // schedule without being asked.
  it("opens a schedule it cannot draw as its cron, rather than rewriting it", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SchedulePicker value="0 9 1 * *" onChange={onChange} />);

    expect(screen.getByLabelText("Cron expression")).toHaveValue("0 9 1 * *");
    expect(onChange).not.toHaveBeenCalled();

    // Back to the picker makes what its fields show the schedule, so the old
    // expression is not saved underneath a picker that no longer shows it.
    await user.click(screen.getByRole("button", { name: "Use the picker" }));
    expect(onChange).toHaveBeenLastCalledWith("0 9 * * *");
  });
});

describe("scheduleError", () => {
  it("passes anything at or above the floor", () => {
    expect(scheduleError("*/5 * * * *")).toBeNull();
    expect(scheduleError("0 */2 * * *")).toBeNull();
    expect(scheduleError("0 9 * * *")).toBeNull();
  });

  it("stays quiet about expressions the picker never produced", () => {
    // Not the picker's schedule to judge — the user is looking at prose and a
    // Change button, not an editable field.
    expect(scheduleError("0 9 * * 1")).toBeNull();
  });

  it("rejects an interval finer than the engine's heartbeat", () => {
    expect(scheduleError("*/1 * * * *")).toMatch(/shortest interval/i);
    expect(scheduleError("*/4 * * * *")).toMatch(/shortest interval/i);
  });
});

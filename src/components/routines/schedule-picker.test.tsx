import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SchedulePicker, scheduleError } from "./schedule-picker";

// The mode <Select> is Radix, whose popover needs browser APIs jsdom does not
// provide. Every mode is reachable without it, because the picker seeds its
// mode from the cron it is given — so each test starts in the mode it exercises.

describe("SchedulePicker", () => {
  it("shows no cron expression anywhere", () => {
    render(<SchedulePicker value="0 */6 * * *" onChange={vi.fn()} />);
    expect(screen.queryByText(/\*/)).toBeNull();
    expect(screen.getByText("Every 6 hours")).toBeInTheDocument();
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

  // The draft parser can emit `0 9 * * 1-5`, and routines created before this
  // picker existed carry whatever they were made with. Rounding those to the
  // nearest shape the picker knows would change a schedule without being asked.
  it("describes a schedule it cannot express rather than rewriting it", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SchedulePicker value="0 9 * * 1-5" onChange={onChange} />);

    expect(screen.getByText("Weekdays at 09:00")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /change/i }));
    expect(screen.getByLabelText(/hours between runs/i)).toBeInTheDocument();
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
    expect(scheduleError("0 9 * * 1-5")).toBeNull();
  });

  it("rejects an interval finer than the engine's heartbeat", () => {
    expect(scheduleError("*/1 * * * *")).toMatch(/shortest interval/i);
    expect(scheduleError("*/4 * * * *")).toMatch(/shortest interval/i);
  });
});

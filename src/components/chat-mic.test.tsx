import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatMic } from "./chat-mic";
import type { Dictation } from "@/lib/use-dictation";

function dictationWith(over: Partial<Dictation> = {}): Dictation {
  return {
    supported: true,
    state: "idle",
    seconds: 0,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    cancel: vi.fn(),
    ...over,
  };
}

describe("ChatMic", () => {
  it("offers nothing in a browser that cannot record", () => {
    render(<ChatMic dictation={dictationWith({ supported: false })} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("starts recording when asked", async () => {
    const user = userEvent.setup();
    const dictation = dictationWith();
    render(<ChatMic dictation={dictation} />);

    await user.click(screen.getByRole("button", { name: /dictate/i }));

    expect(dictation.start).toHaveBeenCalled();
  });

  it("stops on a second press rather than needing the button held", async () => {
    const user = userEvent.setup();
    const dictation = dictationWith({ state: "recording", seconds: 4 });
    render(<ChatMic dictation={dictation} />);

    await user.click(screen.getByRole("button", { name: /stop recording/i }));

    expect(dictation.stop).toHaveBeenCalled();
  });

  // The ceiling is two minutes, and a recording that ends by itself with no
  // warning reads as a failure. The count is the warning.
  it("counts out loud while it records", () => {
    render(<ChatMic dictation={dictationWith({ state: "recording", seconds: 7 })} />);

    expect(screen.getByText("0:07")).toBeInTheDocument();
  });

  it("counts past a minute the way a clock does", () => {
    render(<ChatMic dictation={dictationWith({ state: "recording", seconds: 75 })} />);

    expect(screen.getByText("1:15")).toBeInTheDocument();
  });

  it("throws the recording away on Escape", () => {
    const dictation = dictationWith({ state: "recording", seconds: 4 });
    render(<ChatMic dictation={dictation} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(dictation.cancel).toHaveBeenCalled();
  });

  it("leaves Escape alone when nothing is being recorded", () => {
    const dictation = dictationWith();
    render(<ChatMic dictation={dictation} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(dictation.cancel).not.toHaveBeenCalled();
  });

  it("cannot be pressed again while the recording is being transcribed", () => {
    render(<ChatMic dictation={dictationWith({ state: "transcribing" })} />);

    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("says what it is doing while it is transcribing", () => {
    render(<ChatMic dictation={dictationWith({ state: "transcribing" })} />);

    expect(screen.getByRole("button", { name: /transcribing/i })).toBeInTheDocument();
  });
});

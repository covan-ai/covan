import { afterEach, describe, expect, it, vi } from "vitest";
import { ANSWER_EVENT, announceAnswerAction, type AnswerAction } from "./answer-events";

const heard: AnswerAction[] = [];
const listener = (e: Event) => heard.push((e as CustomEvent<AnswerAction>).detail);

afterEach(() => {
  vi.unstubAllGlobals();
  window.removeEventListener(ANSWER_EVENT, listener);
  heard.length = 0;
});

describe("announceAnswerAction", () => {
  it("dispatches one event carrying exactly what it was given", () => {
    window.addEventListener(ANSWER_EVENT, listener);

    announceAnswerAction({ action: "saved", messageId: "m1", format: "docx" });

    expect(heard).toEqual([{ action: "saved", messageId: "m1", format: "docx" }]);
  });

  it("is named for the app, so nothing else on the page answers to it", () => {
    expect(ANSWER_EVENT).toBe("covan:answer");
  });

  it("does nothing, and does not throw, with nobody listening", () => {
    expect(() => announceAnswerAction({ action: "copied", messageId: "m1" })).not.toThrow();
  });

  it("does not throw when a listener does", () => {
    // jsdom reports an exception thrown in a listener to the console rather
    // than to the caller; either way the caller carries on.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = (e: Event) => e.preventDefault();
    window.addEventListener("error", onError);
    const throwing = () => {
      throw new Error("boom");
    };
    window.addEventListener(ANSWER_EVENT, throwing);

    expect(() => announceAnswerAction({ action: "spoken", messageId: "m1" })).not.toThrow();

    window.removeEventListener(ANSWER_EVENT, throwing);
    window.removeEventListener("error", onError);
    quiet.mockRestore();
  });

  it("does nothing without a window", () => {
    vi.stubGlobal("window", undefined);
    expect(() => announceAnswerAction({ action: "copied", messageId: "m1" })).not.toThrow();
  });

  it("does not throw when the event cannot be built", () => {
    vi.stubGlobal("CustomEvent", undefined);
    expect(() => announceAnswerAction({ action: "copied", messageId: "m1" })).not.toThrow();
  });
});

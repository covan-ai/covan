import { describe, expect, it } from "vitest";
import { goKeyFor, goKeyReader, isTyping } from "./go-keys";

describe("go keys", () => {
  it("jumps on G then a letter within a second, and starts a thread on N", () => {
    let t = 0;
    const read = goKeyReader(() => t);
    expect(read("g")).toBeNull();
    t = 500;
    expect(read("i")).toBe("/inbox");
    expect(read("n")).toBe("new-thread");
    expect(read("g")).toBeNull();
    t = 2000;
    expect(read("i")).toBeNull();
    expect(goKeyFor("/routines")).toBe("G R");
  });

  it("leaves a key alone while somebody is typing", () => {
    expect(isTyping(document.createElement("input"))).toBe(true);
    expect(isTyping(document.createElement("div"))).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { parseReportCommand } from "./reports";

describe("parseReportCommand", () => {
  it("takes everything after the command as the instruction", () => {
    expect(parseReportCommand("/report write up the quarter")).toEqual({
      instruction: "write up the quarter",
    });
  });

  it("keeps an instruction written in any language", () => {
    expect(parseReportCommand("/report bu çeyreği yönetime özetle")).toEqual({
      instruction: "bu çeyreği yönetime özetle",
    });
  });

  it("answers a bare command with an empty instruction, not with nothing", () => {
    // The two are different answers and the caller treats them differently:
    // null sends the line as an ordinary message, an empty instruction opens
    // the dialog to ask for one.
    expect(parseReportCommand("/report")).toEqual({ instruction: "" });
    expect(parseReportCommand("/report   ")).toEqual({ instruction: "" });
  });

  it("reads the command however it was capitalised", () => {
    expect(parseReportCommand("/Report Q3")).toEqual({ instruction: "Q3" });
  });

  it("takes an instruction written on the next line", () => {
    expect(parseReportCommand("/report\nwrite up the quarter")).toEqual({
      instruction: "write up the quarter",
    });
  });

  it("is not fooled by a longer word that starts the same way", () => {
    expect(parseReportCommand("/reporting is broken")).toBeNull();
  });

  it("only counts at the start of the message", () => {
    // Otherwise a message that merely mentions the command would be swallowed
    // instead of sent.
    expect(parseReportCommand("remind me: /report is a thing now")).toBeNull();
  });

  it("leaves an ordinary message alone", () => {
    expect(parseReportCommand("how did Q3 go?")).toBeNull();
    expect(parseReportCommand("")).toBeNull();
  });
});

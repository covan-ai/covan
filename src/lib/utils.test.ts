import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps a type-ladder size beside a text colour", () => {
    expect(cn("text-meta", "text-muted-foreground")).toBe("text-meta text-muted-foreground");
    expect(cn("text-title-lg font-semibold", "text-foreground")).toBe(
      "text-title-lg font-semibold text-foreground",
    );
  });

  it("still lets a later size win over an earlier one", () => {
    expect(cn("text-sm", "text-meta")).toBe("text-meta");
    expect(cn("text-lead", "text-xs")).toBe("text-xs");
  });
});

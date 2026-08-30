import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SourceChip } from "./source-chip";
import { STALE_AFTER_DAYS } from "@/lib/relative-time";

const daysAgo = (n: number) => Date.now() - n * 86_400_000;
const chip = () => screen.getByTitle(/./);

describe("a citation with a date", () => {
  it("says how old the document is, not only which one it was", () => {
    // The whole complaint: retrieval is working as designed when a January
    // process document is the best match for a January question in September.
    // Nothing else in the interface was in a position to mention the nine
    // months.
    render(<SourceChip source={{ id: "d1", name: "onboarding.md" }} uploadedAt={daysAgo(12)} />);

    expect(screen.getByText("onboarding.md")).toBeInTheDocument();
    expect(screen.getByText("12 days ago")).toBeInTheDocument();
  });

  it("puts both in the tooltip, where a truncated name is readable again", () => {
    render(
      <SourceChip source={{ id: "d1", name: "a-very-long-name.md" }} uploadedAt={daysAgo(3)} />,
    );
    expect(chip()).toHaveAttribute("title", "a-very-long-name.md — uploaded 3 days ago");
  });
});

describe("a citation old enough to be worth checking", () => {
  it("warns past the threshold", () => {
    render(<SourceChip source={{ id: "d1", name: "process.md" }} uploadedAt={daysAgo(200)} />);

    expect(screen.getByText("6 months ago")).toBeInTheDocument();
    expect(chip().className).toContain("amber");
  });

  it("does not warn a day early", () => {
    render(
      <SourceChip
        source={{ id: "d1", name: "process.md" }}
        uploadedAt={daysAgo(STALE_AFTER_DAYS - 1)}
      />,
    );
    expect(chip().className).not.toContain("amber");
  });

  it("says it in words as well as in colour", () => {
    // Colour alone reaches neither a screen reader nor somebody who cannot tell
    // amber from grey, and a warning nobody perceives is not a warning.
    render(<SourceChip source={{ id: "d1", name: "process.md" }} uploadedAt={daysAgo(200)} />);
    expect(screen.getByText(/older than 90 days; check it is still current/)).toBeInTheDocument();
  });
});

describe("a citation with no date to give", () => {
  it("still renders, for a reply written before ids were stored", () => {
    // The column held bare names then, and a name cannot be resolved back to a
    // document without guessing. The citation survives; the age does not.
    render(<SourceChip source={{ id: null, name: "old-answer.md" }} />);

    expect(screen.getByText("old-answer.md")).toBeInTheDocument();
    expect(chip()).toHaveAttribute("title", "old-answer.md");
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
  });

  it("stays quiet for a document that has since been deleted", () => {
    // It has an id, but nothing on this screen knows the id any more.
    render(<SourceChip source={{ id: "gone", name: "deleted.md" }} />);

    expect(screen.getByText("deleted.md")).toBeInTheDocument();
    expect(chip().className).not.toContain("amber");
  });

  it("never guesses an age from a missing date", () => {
    // The failure worth naming: `uploadedAt` defaulting to 0 would render epoch
    // 1970 as "55 years ago" and paint every old citation as a warning.
    render(<SourceChip source={{ id: null, name: "x.md" }} />);
    expect(screen.queryByText(/years ago/)).not.toBeInTheDocument();
  });
});

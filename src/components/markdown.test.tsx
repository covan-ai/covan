import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Markdown } from "./markdown";

/**
 * What a model actually writes into a chat reply, and what this makes of it.
 *
 * Two halves. The first is the constructs that used to fall through to
 * paragraphs — tables above all, because a model asked to compare three things
 * answers with one every time, and a table rendered as text is not a degraded
 * table but a wall of pipes.
 *
 * The second is the half-finished input, which is the interesting half. This
 * renderer is handed a growing prefix of the answer on every token of every
 * streamed reply, so "a fence that has not been closed yet" and "a table with
 * a header and no rows" are not error cases — they are what it sees for most
 * of the time it is on screen. Every one of those tests is a frame somebody
 * watches go by.
 */

const draw = (md: string) => render(<Markdown content={md} />);

describe("tables", () => {
  const TABLE = [
    "| Plan | Seats | Price |",
    "| --- | ---: | :---: |",
    "| Team | 10 | $40 |",
    "| Business | 50 | $32 |",
  ].join("\n");

  it("renders one, rather than a wall of pipes", () => {
    draw(TABLE);

    const table = screen.getByRole("table");
    expect(within(table).getByText("Plan")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("$32")).toBeInTheDocument();
  });

  it("takes the alignment from the rule row", () => {
    draw(TABLE);

    const [plan, seats, price] = screen.getAllByRole("columnheader");
    expect(plan.className).toContain("text-left");
    expect(seats.className).toContain("text-right");
    expect(price.className).toContain("text-center");
  });

  it("reads a row written without its outer pipes", () => {
    draw(["Plan | Price", "--- | ---", "Team | $40"].join("\n"));

    expect(within(screen.getByRole("table")).getByText("$40")).toBeInTheDocument();
  });

  it("leaves a line of pipes alone when no rule row follows it", () => {
    // Which is what a table is for one frame while it streams, and what a
    // sentence about `a | b` is forever.
    draw("The separator is | and nothing else.");

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("lists", () => {
  it("keeps a nested list nested", () => {
    draw(["- Deploy", "  - Build it", "  - Ship it", "- Tell everyone"].join("\n"));

    const outer = screen.getAllByRole("list")[0];
    expect(within(outer).getAllByRole("listitem")).toHaveLength(4);
    // The two indented ones live inside the first item, not beside it.
    const first = within(outer).getAllByRole("listitem")[0];
    expect(within(first).getAllByRole("listitem")).toHaveLength(2);
  });

  it("tells an ordered list from a bulleted one", () => {
    const { container } = draw(["1. First", "2. Second"].join("\n"));
    expect(container.querySelector("ol")).toBeInTheDocument();
    expect(container.querySelector("ul")).not.toBeInTheDocument();
  });

  it("does not trip over an answer that opens on an indented bullet", () => {
    draw("  - orphaned");
    expect(screen.getByRole("listitem")).toHaveTextContent("orphaned");
  });
});

describe("blocks", () => {
  it("renders headings down to the sixth", () => {
    draw(["#### Caveats", "Body text."].join("\n"));
    expect(screen.getByText("Caveats")).toBeInTheDocument();
    // Not swallowed into the paragraph beneath it.
    expect(screen.getByText("Body text.")).toBeInTheDocument();
  });

  it("renders a horizontal rule", () => {
    const { container } = draw(["Above", "---", "Below"].join("\n"));
    expect(container.querySelector("hr")).toBeInTheDocument();
  });

  it("keeps a fence whose info string says more than the language", () => {
    // ` ```ts title="x" ` is a real thing models write. The old pattern
    // required the language to be the whole of the line, so this fell through
    // and rendered as paragraphs with the backticks still in them.
    const { container } = draw(['```ts title="server.ts"', "const x = 1;", "```"].join("\n"));

    expect(container.querySelector("pre")).toHaveTextContent("const x = 1;");
    expect(screen.getByText("ts")).toBeInTheDocument();
  });

  it("renders a tilde fence", () => {
    const { container } = draw(["~~~python", "x = 1", "~~~"].join("\n"));
    expect(container.querySelector("pre")).toHaveTextContent("x = 1");
  });
});

describe("inline marks", () => {
  it("renders emphasis inside bold", () => {
    // The old patterns matched "anything but a star", so a nested mark stopped
    // the outer one matching and the italic alternative ate the first two
    // stars: `**bold *inner* **` came out as italic "bold ".
    const { container } = draw("**bold *inner* text**");

    const strong = container.querySelector("strong");
    expect(strong).toHaveTextContent("bold inner text");
    expect(within(strong as HTMLElement).getByText("inner").tagName).toBe("EM");
  });

  it("renders strikethrough", () => {
    const { container } = draw("~~gone~~");
    expect(container.querySelector("del")).toHaveTextContent("gone");
  });

  it("treats what is inside a code span as text", () => {
    const { container } = draw("Use `**literal**` here");
    expect(container.querySelector("code")).toHaveTextContent("**literal**");
    expect(container.querySelector("strong")).not.toBeInTheDocument();
  });

  it("refuses a link that is not a link", () => {
    draw("[click](javascript:alert(1))");
    expect(screen.getByRole("link")).toHaveAttribute("href", "#");
  });

  it("keeps an ordinary link", () => {
    draw("[docs](https://covan.app/docs)");
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://covan.app/docs");
  });
});

describe("math", () => {
  it("renders display math from a $$ block", () => {
    const { container } = draw("$$E = mc^2$$");

    expect(container.querySelector(".katex-display")).toBeInTheDocument();
  });

  it("renders display math split across lines", () => {
    const { container } = draw(
      ["$$", "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}", "$$"].join("\n"),
    );

    expect(container.querySelector(".katex-display")).toBeInTheDocument();
  });

  it("renders inline math from $...$", () => {
    const { container } = draw("The identity is $x^2 + y^2 = r^2$ here.");

    expect(container.querySelector(".katex")).toBeInTheDocument();
    // Inline, not display — the paragraph around it keeps flowing.
    expect(container.querySelector(".katex-display")).not.toBeInTheDocument();
  });

  it("does not treat a dollar amount as math", () => {
    draw("The cost is $40 per seat.");

    expect(screen.getByText(/\$40 per seat/)).toBeInTheDocument();
  });

  it("leaves an unclosed math block as raw text while it streams", () => {
    // What a display block looks like for every line of it but the last one,
    // for the whole time an answer is arriving.
    const { container } = draw(["$$", "E = mc^2"].join("\n"));

    expect(container.querySelector(".katex")).not.toBeInTheDocument();
    expect(screen.getByText(/E = mc\^2/)).toBeInTheDocument();
  });

  it("leaves an unclosed inline dollar as raw text", () => {
    const { container } = draw("The value is $x with no closing mark");

    expect(container.querySelector(".katex")).not.toBeInTheDocument();
    expect(screen.getByText(/\$x with no closing mark/)).toBeInTheDocument();
  });
});

describe("half an answer", () => {
  it("renders a code block that has been opened and not closed", () => {
    // Every streamed code block is this, for as long as it takes to write.
    const { container } = draw(["Here:", "```ts", "const x = 1;"].join("\n"));

    expect(container.querySelector("pre")).toHaveTextContent("const x = 1;");
  });

  it("renders a table with a header and no rows yet", () => {
    draw(["| Plan | Price |", "| --- | --- |"].join("\n"));

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("pads a row that has not finished arriving", () => {
    draw(["| Plan | Seats | Price |", "| --- | --- | --- |", "| Team | 10"].join("\n"));

    const cells = screen.getAllByRole("cell");
    expect(cells).toHaveLength(3);
    expect(cells[2]).toBeEmptyDOMElement();
  });

  it("leaves an unclosed bold mark as the text it still is", () => {
    // Non-greedy patterns rather than negated ones, so a dangling `**` at the
    // end of what has arrived does not swallow the rest of the answer when the
    // rest of the answer shows up.
    const { container } = draw("This is **not finished");

    expect(container.querySelector("strong")).not.toBeInTheDocument();
    expect(screen.getByText(/not finished/)).toBeInTheDocument();
  });

  it("renders every prefix of a whole answer without throwing", () => {
    // The real guarantee, stated the way the streaming path exercises it: the
    // renderer sees this text one character longer each time.
    const answer = [
      "## Pricing",
      "",
      "Two things matter:",
      "",
      "- Seats",
      "  - Billed monthly",
      "- Usage",
      "",
      "| Plan | Price |",
      "| --- | ---: |",
      "| Team | $40 |",
      "",
      "```ts",
      "const seats = 10;",
      "```",
      "",
      "See [the docs](https://covan.app) — **and** ~~ignore~~ the rest.",
    ].join("\n");

    for (let i = 1; i <= answer.length; i++) {
      const { unmount } = render(<Markdown content={answer.slice(0, i)} />);
      unmount();
    }
  });
});

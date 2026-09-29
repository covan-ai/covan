import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useStableCallback } from "./use-stable-callback";

/**
 * A callback that keeps one identity and still sees the latest state.
 *
 * The problem it solves is specific: `React.memo` compares props by identity,
 * and a handler written in a component body is a new function on every render.
 * So a memoised child re-renders anyway, and the memo is a comment.
 *
 * `useCallback` is the usual answer and does not reach here. The chat route's
 * handlers close over `active`, `busy`, `submit` and `streamReply`, none of
 * which is stable either, so a dependency array would just move the churn one
 * level up.
 */

function Probe() {
  const [count, setCount] = useState(0);
  const [seen, setSeen] = useState<number[]>([]);
  const [identities] = useState(() => new Set<unknown>());

  // Closes over `count`, which changes on every press.
  const report = useStableCallback(() => setSeen((s) => [...s, count]));
  identities.add(report);

  return (
    <div>
      <button onClick={() => setCount((c) => c + 1)}>bump</button>
      <button onClick={report}>report</button>
      <output data-testid="identities">{identities.size}</output>
      <output data-testid="seen">{seen.join(",")}</output>
    </div>
  );
}

describe("useStableCallback", () => {
  it("is the same function on every render", async () => {
    render(<Probe />);
    expect(screen.getByTestId("identities")).toHaveTextContent("1");

    await userEvent.click(screen.getByText("bump"));
    await userEvent.click(screen.getByText("bump"));

    expect(screen.getByTestId("identities")).toHaveTextContent("1");
  });

  it("calls the newest version of what it wraps, not the first", async () => {
    // The half a plain ref-and-forget gets wrong. An identity that never
    // changes is easy; an identity that never changes AND still sees this
    // render's state is the whole trick.
    render(<Probe />);

    await userEvent.click(screen.getByText("report"));
    await userEvent.click(screen.getByText("bump"));
    await userEvent.click(screen.getByText("report"));
    await userEvent.click(screen.getByText("bump"));
    await userEvent.click(screen.getByText("report"));

    expect(screen.getByTestId("seen")).toHaveTextContent("0,1,2");
  });

  it("passes its arguments through and hands the result back", async () => {
    let got: [string, number] | null = null;
    let returned: string | null = null;

    function ArgProbe() {
      const fn = useStableCallback((a: string, b: number) => {
        got = [a, b];
        return `${a}:${b}`;
      });
      return <button onClick={() => (returned = fn("x", 2))}>call</button>;
    }

    render(<ArgProbe />);
    await userEvent.click(screen.getByText("call"));

    expect(got).toEqual(["x", 2]);
    expect(returned).toBe("x:2");
  });
});

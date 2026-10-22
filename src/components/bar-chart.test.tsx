import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BarChart } from "./bar-chart";
import { chartDate, chartDay, niceCeiling, tickLabel } from "@/lib/chart-scale";

describe("the scale", () => {
  it("rounds the top up to a number a gridline can say", () => {
    expect(niceCeiling(0)).toBe(0);
    expect(niceCeiling(93)).toBe(100);
    expect(niceCeiling(136)).toBe(150);
    expect(niceCeiling(112)).toBe(120);
    expect(niceCeiling(0.37)).toBe(0.4);
    expect(tickLabel(60, "credits")).toBe("60");
    expect(tickLabel(12_500, "credits")).toBe("12.5k");
    expect(tickLabel(2.5, "usd")).toBe("$2.5");
  });

  it("names a day as the calendar day it is", () => {
    expect(chartDay("2026-10-21")).toBe("Wed 21 Oct");
    expect(chartDate("2026-10-09")).toBe("9 Oct");
  });
});

describe("BarChart", () => {
  const bars = [
    {
      key: "a",
      value: 40,
      title: "Tue 20 Oct · 40 credits",
      detail: "Research 40",
      previous: true,
    },
    { key: "b", value: 93, title: "Wed 21 Oct · 93 credits", detail: "Research 41 · Support 30" },
  ];

  it("labels three gridlines and puts the numbers in a table for a screen reader", () => {
    render(
      <BarChart bars={bars} label="Credits per day" tick={String} axis={["20 Oct", "Today"]} />,
    );
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Credits per day" });
    expect(table).toHaveTextContent("Wed 21 Oct · 93 credits");
    expect(table).toHaveTextContent("Research 41 · Support 30");
  });

  it("shows the day's split on hover, and draws the week before lighter", () => {
    const { container } = render(
      <BarChart bars={bars} label="Credits per day" tick={String} axis={[]} />,
    );
    const columns = container.querySelectorAll("i");
    expect(columns[0]).toHaveClass("bg-bar-prev");
    expect(columns[1]).toHaveClass("bg-bar");

    fireEvent.mouseEnter(columns[1]!.parentElement!);
    const tips = screen.getAllByText("Wed 21 Oct · 93 credits");
    expect(tips.some((el) => el.tagName === "B")).toBe(true);
    expect(columns[1]).toHaveClass("bg-foreground");
  });
});

import { useState, type ReactNode } from "react";
import { niceCeiling } from "@/lib/chart-scale";
import { cn } from "@/lib/utils";

export type ChartBar = {
  key: string;
  value: number;
  /** The tooltip's first line, and the row in the table a screen reader gets. */
  title: string;
  /** The tooltip's second line: "Research 41 · Support 30". */
  detail?: string;
  /** Drawn in the lighter grey: the week before, beside this one. */
  previous?: boolean;
};

/**
 * Columns over a few days (Main: credits spent, last 14 days). Three
 * gridlines — the top, half, zero — labelled on the left; 18px bars with
 * rounded tops; the week before in `bar-prev`; hover a day for an ink tip
 * with its split. The bars are a picture: the same numbers are in a table a
 * screen reader reads instead.
 */
export function BarChart({
  bars,
  label,
  tick,
  axis,
  className,
}: {
  bars: ChartBar[];
  label: string;
  /** A gridline's number. */
  tick: (value: number) => string;
  /** Under the bars, spread from the first day to the last: "9 Oct · 16 Oct · Today". */
  axis: ReactNode[];
  className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const top = niceCeiling(Math.max(0, ...bars.map((b) => b.value)));
  const lines = top > 0 ? [top, top / 2, 0] : [0];

  return (
    <div className={cn("pl-8", className)}>
      <div aria-hidden className="relative mt-5 h-40">
        {lines.map((v) => (
          <div
            key={v}
            className="absolute right-0 left-0 h-0 border-t border-hairline"
            style={{ top: top > 0 ? `${(1 - v / top) * 100}%` : "100%" }}
          >
            <span className="absolute right-full -top-2 pr-2 text-xs text-micro-foreground tabular-nums">
              {tick(v)}
            </span>
          </div>
        ))}
        <div
          className="absolute inset-0 flex items-end gap-0.5"
          onMouseLeave={() => setHover(null)}
        >
          {bars.map((b, i) => {
            const height = top > 0 ? (b.value / top) * 100 : 0;
            const edge =
              i < 3 ? "left-0" : i > bars.length - 4 ? "right-0" : "left-1/2 -translate-x-1/2";
            return (
              <div
                key={b.key}
                className="relative flex h-full flex-1 items-end justify-center"
                onMouseEnter={() => setHover(i)}
              >
                {hover === i && (
                  <div
                    className={cn(
                      "absolute bottom-[calc(100%+8px)] z-10 rounded-md bg-foreground px-2.5 py-2 text-xs leading-[1.4] whitespace-nowrap text-background shadow-card",
                      edge,
                    )}
                  >
                    <b className="block font-semibold">{b.title}</b>
                    {b.detail}
                  </div>
                )}
                <i
                  className={cn(
                    "block w-[18px] max-w-full rounded-t-[4px] transition-colors",
                    hover === i ? "bg-foreground" : b.previous ? "bg-bar-prev" : "bg-bar",
                  )}
                  style={{ height: b.value > 0 ? `max(2px, ${height}%)` : 0 }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div aria-hidden className="mt-2 flex justify-between text-xs text-micro-foreground">
        {axis.map((a, i) => (
          <span key={i}>{a}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {bars.map((b) => (
            <tr key={b.key}>
              <th scope="row">{b.title}</th>
              <td>{b.detail ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

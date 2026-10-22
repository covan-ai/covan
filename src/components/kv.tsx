import type { ReactNode } from "react";

/** Key and value rows (A7's Schedule, Delivers to): a 140px muted key, hairlines between. */
export function KeyValue({ rows }: { rows: Array<{ k: ReactNode; v: ReactNode }> }) {
  return (
    <dl className="m-0">
      {rows.map((r, i) => (
        <div
          key={i}
          className="grid min-h-9 grid-cols-[140px_minmax(0,1fr)] items-center gap-x-4 border-b border-hairline text-sm last:border-b-0"
        >
          <dt className="text-meta text-muted-foreground">{r.k}</dt>
          <dd className="m-0 min-w-0 py-1.5">{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

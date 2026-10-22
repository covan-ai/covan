import type { KeyboardEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Right-aligned and tabular. */
  num?: boolean;
  className?: string;
  /** Hidden on a narrow screen, where the table would otherwise scroll for it. */
  hideBelow?: "md" | "lg";
};

/**
 * A table of things (DESIGN.md §7). A row can open what it is about; the
 * whole row answers the pointer and Enter, so a cell's own link or menu is a
 * convenience rather than the only way in.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  label,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  label?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const hide = (c: Column<T>) =>
    c.hideBelow === "md"
      ? "hidden md:table-cell"
      : c.hideBelow === "lg"
        ? "hidden lg:table-cell"
        : "";
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead key={c.key} num={c.num} className={cn(hide(c), c.className)}>
              {c.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={rowKey(row)}
            {...(onRowClick
              ? {
                  tabIndex: 0,
                  onClick: () => onRowClick(row),
                  onKeyDown: (e: KeyboardEvent) => {
                    if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(row);
                  },
                  className:
                    "cursor-pointer hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                }
              : {})}
          >
            {columns.map((c) => (
              <TableCell key={c.key} num={c.num} className={cn(hide(c), c.className)}>
                {c.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** "Showing 13 of 312" and Previous / Next. */
export function Pagination({
  shown,
  total,
  page,
  pageCount,
  onPage,
}: {
  shown: number;
  total: number;
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="mt-4 flex items-center justify-between text-meta text-muted-foreground">
      <span>
        Showing {shown.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

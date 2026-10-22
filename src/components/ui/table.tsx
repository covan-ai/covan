import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * The table (DESIGN.md §7): a 36px uppercase header on the border, 44px rows
 * on hairlines, the last one without. Numbers are right-aligned and tabular
 * through `num` on the cell.
 */
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="w-full overflow-x-auto">
      <table ref={ref} className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => <thead ref={ref} className={className} {...props} />);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child>td]:border-b-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => <tr ref={ref} className={className} {...props} />,
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & { num?: boolean }
>(({ className, num, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-9 border-b border-border px-2.5 text-left text-xs font-medium tracking-[0.06em] whitespace-nowrap text-micro-foreground uppercase",
      num && "text-right",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & { num?: boolean }
>(({ className, num, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "h-11 border-b border-hairline px-2.5 align-middle whitespace-nowrap",
      num && "text-right tabular-nums",
      className,
    )}
    {...props}
  />
));
TableCell.displayName = "TableCell";

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };

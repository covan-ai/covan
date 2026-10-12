import type { ReactNode } from "react";
import { PAGE_WIDTHS } from "@/lib/page-widths";
import { cn } from "@/lib/utils";

/**
 * One settings page, inside the area's layout.
 *
 * The layout's `PageContainer` is the dashboard width so the section rail and
 * the page can sit side by side; this clamps the page itself back to the width
 * its role calls for, from the same table `PageContainer` reads, so a settings
 * form is exactly as wide here as it was when it was a page of its own.
 */
export function SettingsPage({
  width = "form",
  children,
}: {
  width?: "form" | "list";
  children: ReactNode;
}) {
  return <div className={cn("min-w-0", PAGE_WIDTHS[width])}>{children}</div>;
}

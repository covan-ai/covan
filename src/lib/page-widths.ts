/**
 * Page widths by what a page is (DESIGN.md §7). Every page under the top bar
 * takes one of these through `PageBody`; none sets its own.
 */
export const PAGE_WIDTHS = {
  home: "max-w-[1120px]",
  table: "max-w-[1160px]",
  list: "max-w-[1000px]",
  // 800px of content inside the 40px padding (A9).
  settings: "max-w-[880px]",
  form: "max-w-[760px]",
  reading: "max-w-[760px]",
  // The old tiers, until `page-container.tsx` and `settings-page.tsx` go
  // with the screens that still use them (Phase 3).
  dashboard: "max-w-[1120px]",
} as const;

export type PageWidth = keyof typeof PAGE_WIDTHS;

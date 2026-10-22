/**
 * Page widths by what a page is (DESIGN.md §7). Every page under the top bar
 * takes one of these through `PageBody`; none sets its own.
 */
export const PAGE_WIDTHS = {
  home: "max-w-[1120px]",
  table: "max-w-[1160px]",
  list: "max-w-[1000px]",
  // 800px of content inside the 40px padding (A9, A16).
  settings: "max-w-[880px]",
  // 880px: the settings pages with tables (A8, A15, A18, A26, A27).
  "settings-wide": "max-w-[960px]",
  form: "max-w-[760px]",
  // 840px of content: an agent's Configuration (A10).
  agent: "max-w-[920px]",
  reading: "max-w-[760px]",
} as const;

export type PageWidth = keyof typeof PAGE_WIDTHS;

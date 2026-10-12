// Container width tiers by page role. Keeps every in-app page on the same
// rhythm so screens don't drift apart. All tiers share the same padding.
export const PAGE_WIDTHS = {
  dashboard: "max-w-[1200px]",
  list: "max-w-4xl",
  form: "max-w-2xl",
} as const;

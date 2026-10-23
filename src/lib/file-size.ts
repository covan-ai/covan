/**
 * A file's size, in the largest unit that still reads as a number.
 *
 * The interface said `${(size / 1024).toFixed(0)} KB` everywhere it said
 * anything, which is fine for the notes file and wrong for the one the limit is
 * written for: a 4 MB PDF read "4096 KB", and a column of those is a column
 * nobody compares. Uploads cap at 100 MB, so MB is the top of the ladder and
 * there is no GB case to get right.
 *
 * Rounded to one decimal above a kilobyte and to none below it, because "0.4 KB"
 * is a worse answer than "412 B" for the only thing the number is for: telling
 * two rows apart at a glance.
 */
export function formatFileSize(bytes: number, locale: string = "en"): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  // No grouping: "1023 B" is how the ladder reads just under a kilobyte, and the
  // separator is the reader's (a Turkish reader sees "1,5 KB").
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: false });
  const tenth = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  });
  const number = (n: number) => (n < 10 ? tenth.format(n) : whole.format(n));
  if (bytes < 1024) return `${whole.format(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${number(kb)} KB`;
  const mb = kb / 1024;
  return `${number(mb)} MB`;
}

/**
 * A file's size, in the largest unit that still reads as a number.
 *
 * The interface said `${(size / 1024).toFixed(0)} KB` everywhere it said
 * anything, which is fine for the notes file and wrong for the one the limit is
 * written for: a 4 MB PDF read "4096 KB", and a column of those is a column
 * nobody compares. Uploads cap at 10 MB, so MB is the top of the ladder and
 * there is no GB case to get right.
 *
 * Rounded to one decimal above a kilobyte and to none below it, because "0.4 KB"
 * is a worse answer than "412 B" for the only thing the number is for: telling
 * two rows apart at a glance.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

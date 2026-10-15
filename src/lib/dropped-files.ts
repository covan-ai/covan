/**
 * Every file in what was dropped, folders included.
 *
 * `dataTransfer.files` lists a dropped folder as one zero-byte "file" with the
 * folder's name, so dropping a folder of handbooks used to upload nothing and
 * say "the file is empty". The entries API is how a page reads into a folder:
 * every browser this app supports has it, under its webkit name. Hidden files
 * (`.DS_Store`, `.git`) are skipped — nobody means to upload those.
 *
 * At most `limit` files, so dropping a home directory by accident is a
 * refusal, not a thousand uploads.
 */
export async function filesFromDrop(dt: DataTransfer, limit = 500): Promise<File[]> {
  const items = Array.from(dt.items ?? []);
  const entries = items
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) return Array.from(dt.files ?? []);

  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (out.length >= limit || entry.name.startsWith(".")) return;
    if (entry.isFile) {
      out.push(
        await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        ),
      );
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // `readEntries` answers in batches and an empty batch is the end.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

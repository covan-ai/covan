import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Choosing which Drive folder a connection watches.
 *
 * One level at a time, through our own API, because the browser holds no Google
 * token — and giving it one so it could call Drive directly would undo the
 * reason the token lives in a column no client can select.
 *
 * A tree view would be nicer and would need every level fetched to draw itself.
 * This walks: click a folder to go into it, and the button always applies to
 * where you are standing, which also makes "the folder itself, not one inside
 * it" expressible.
 */
export function DriveFolderDialog({
  connectionId,
  accountLabel,
  open,
  onOpenChange,
  onChoose,
  saving,
}: {
  connectionId: string;
  accountLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (folder: { id: string; name: string }) => void;
  saving: boolean;
}) {
  // The path so far. `root` is Drive's own name for the top of My Drive, and
  // it is never a valid destination — a connection to all of somebody's Drive
  // is the thing this dialog exists to avoid.
  const [path, setPath] = useState<Array<{ id: string; name: string }>>([]);
  const here = path[path.length - 1];
  const parentId = here?.id ?? "root";

  const folders = useQuery({
    queryKey: ["drive-folders", connectionId, parentId],
    queryFn: () => api.connections.folders(connectionId, parentId),
    enabled: open,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPath([]);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>
            Everything in this folder — and one level of subfolders — is kept in step with the
            bundle. {accountLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground">
          <button
            type="button"
            className="underline underline-offset-4 hover:text-foreground"
            onClick={() => setPath([])}
          >
            My Drive
          </button>
          {path.map((folder, index) => (
            <span key={folder.id} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5" />
              <button
                type="button"
                className="underline underline-offset-4 hover:text-foreground"
                onClick={() => setPath(path.slice(0, index + 1))}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </div>

        <div className="max-h-[280px] overflow-y-auto rounded-lg border border-hairline">
          {folders.isPending ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
              Reading your Drive…
            </p>
          ) : folders.isError ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {folders.error instanceof Error
                ? folders.error.message
                : "Could not read your Drive."}
            </p>
          ) : folders.data && folders.data.length > 0 ? (
            <ul>
              {folders.data.map((folder) => (
                <li key={folder.id}>
                  <button
                    type="button"
                    onClick={() => setPath([...path, folder])}
                    className="flex w-full items-center gap-3 border-b border-hairline px-4 py-3 text-left text-sm last:border-b-0 hover:bg-surface-hover"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No folders in here.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!here || saving} onClick={() => here && onChoose(here)}>
            {saving ? "Saving…" : here ? `Use “${here.name}”` : "Go into a folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

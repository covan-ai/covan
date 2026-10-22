import { toast } from "sonner";

/**
 * The three things a toast says (DESIGN.md §11, A33): it was saved; it was
 * done, and here is Undo; it failed, and here is Retry when there is one.
 * Ink for the first two, white with the word in red for a failure.
 */
export const notify = {
  saved: (message = "Saved") => toast.success(message),
  undo: (message: string, onUndo: () => void) =>
    toast(message, { action: { label: "Undo", onClick: onUndo } }),
  failed: (message: string, onRetry?: () => void) =>
    toast.error(message, onRetry ? { action: { label: "Retry", onClick: onRetry } } : undefined),
};

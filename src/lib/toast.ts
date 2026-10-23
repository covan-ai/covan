import { toast } from "sonner";
import { i18n } from "@/i18n";

/**
 * The three things a toast says (DESIGN.md §11, A33): it was saved; it was
 * done, and here is Undo; it failed, and here is Retry when there is one.
 * Ink for the first two, white with the word in red for a failure.
 *
 * Client only, which is why it may use the instance directly: a toast is
 * raised from an event handler, after hydration, in the one language the
 * page is in. The words are looked up at the call, never at import.
 */
export const notify = {
  saved: (message?: string) => toast.success(message ?? i18n.t("Saved")),
  undo: (message: string, onUndo: () => void) =>
    toast(message, { action: { label: i18n.t("Undo"), onClick: onUndo } }),
  failed: (message: string, onRetry?: () => void) =>
    toast.error(
      message,
      onRetry ? { action: { label: i18n.t("Retry"), onClick: onRetry } } : undefined,
    ),
};

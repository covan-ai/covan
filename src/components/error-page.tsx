import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/chip";
import { StatusDot } from "@/components/status-dot";
import { FeedbackDialog } from "@/components/feedback-dialog";
import { cn } from "@/lib/utils";
import { errorIdOf } from "@/lib/error-id";

/**
 * When something is wrong (A31): what happened in plain words, what is safe,
 * and the way out. A missing page names the path it was asked for; a crash
 * gives an id to read out to support, never a stack trace.
 *
 * Inside the shell the sidebar stays (the router's default error component);
 * at the root, before there is a shell, the page stands alone and offers
 * the way home instead of feedback.
 */
export function ErrorPage({
  kind,
  errorId,
  onRetry,
  standalone = false,
}: {
  kind: "not-found" | "error";
  errorId?: string;
  onRetry?: () => void;
  standalone?: boolean;
}) {
  const { t } = useTranslation();
  const path = useRouterState({ select: (s) => s.location.href });
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const body =
    kind === "not-found" ? (
      <>
        <h1 className="m-0 text-title font-semibold">{t("There is nothing here")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            "The link may be old, or the thread was deleted. Deleted things can be brought back for 30 days from Settings.",
          )}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to="/app">{t("Go home")}</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/inbox">{t("Open the Inbox")}</Link>
          </Button>
        </div>
        <Chip tone="code" className="mt-5 max-w-[320px] truncate bg-transparent">
          {path}
        </Chip>
      </>
    ) : (
      <>
        <StatusDot state="failed" className="mb-4" />
        <h1 className="m-0 text-title font-semibold">{t("Something went wrong on this page")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            "Nothing you did was lost; threads and documents are saved as they go. Reloading usually fixes it. If it keeps happening, send us the id below.",
          )}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button onClick={onRetry ?? (() => window.location.reload())}>{t("Reload")}</Button>
          {standalone ? (
            <Button asChild variant="secondary">
              <a href="/app">{t("Go home")}</a>
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setFeedbackOpen(true)}>
              {t("Send feedback")}
            </Button>
          )}
        </div>
        {errorId && (
          <div className="mt-5 flex items-center justify-center gap-2">
            <Chip tone="code" className="bg-transparent">
              {errorId}
            </Chip>
            <button
              type="button"
              className="font-mono text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(errorId)
                  .then(() => toast.success(t("Copied")))
                  .catch(() => {})
              }
            >
              {t("Copy")}
            </button>
          </div>
        )}
        {!standalone && (
          <FeedbackDialog
            open={feedbackOpen}
            onOpenChange={setFeedbackOpen}
            path={errorId ? `${path} (${errorId})` : path}
          />
        )}
      </>
    );
  return (
    <div
      className={cn(
        "flex flex-1 items-center justify-center bg-background px-4 py-16",
        standalone && "min-h-dvh",
      )}
    >
      <div className="flex max-w-[420px] flex-col items-center text-center">{body}</div>
    </div>
  );
}

/** The router's default: a crash in a page, logged with the id it shows. */
export function RouteErrorPage({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();
  const [errorId] = useState(() => errorIdFor(error));
  return (
    <ErrorPage
      kind="error"
      errorId={errorId}
      onRetry={() => {
        void router.invalidate();
        reset();
      }}
    />
  );
}

function errorIdFor(error: unknown): string {
  const id = errorIdOf(error);
  console.error(id, error);
  return id;
}

import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { useConnectComposio, useStartConnection } from "@/hooks/use-connections";
import { ToolLogo } from "@/components/integrations/tool-logo";
import { Button } from "@/components/ui/button";
import type { ToolEntry } from "@/lib/onboarding-config";
import { cn } from "@/lib/utils";

/**
 * The one next step, under the assistant's opening line.
 *
 * The opening proposes connecting the first tool the person named; this is
 * the button that does it. Drawn by the screen rather than by the model, from
 * the same answer the worker wrote the proposal from, so the two cannot
 * disagree about which tool — and so the card is there even when the opening
 * could not be generated.
 *
 * `DocumentCard`'s row, because that is what a thing-under-a-reply looks like
 * here. "Not now" puts it down for this conversation; connecting the tool
 * takes it down on its own, since the next unconnected tool (or nothing)
 * replaces it.
 */
export function KickoffCard({
  tool,
  bundleId,
  onDismiss,
  className,
}: {
  tool: ToolEntry;
  /**
   * The agent's first knowledge bundle, for the two sources that sync into
   * one. Null sends the person to the Integrations page, which asks.
   */
  bundleId: string | null;
  onDismiss: () => void;
  className?: string;
}) {
  const composio = useConnectComposio();
  const source = useStartConnection();
  const busy = composio.isPending || source.isPending;

  const failed = () => toast.error("Couldn't start that connection. Try it from Integrations.");

  const action = (() => {
    const connect = tool.connect;
    if (connect.kind === "composio") {
      return (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => composio.mutate({ toolkit: connect.slug }, { onError: failed })}
        >
          {busy ? "Opening…" : "Connect"}
        </Button>
      );
    }
    if (connect.kind === "provider" && bundleId) {
      return (
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            source.mutate({ provider: connect.provider, bundleId }, { onError: failed })
          }
        >
          {busy ? "Opening…" : "Connect"}
        </Button>
      );
    }
    return (
      <Button size="sm" asChild>
        <Link to="/integrations">Connect</Link>
      </Button>
    );
  })();

  return (
    <div
      data-coach="kickoff-card"
      className={cn(
        "flex w-full max-w-xl items-center gap-3.5 rounded-lg border border-hairline bg-background px-4 py-3.5",
        className,
      )}
    >
      <ToolLogo tool={tool} size={36} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-base font-semibold leading-tight">Connect {tool.name}</span>
        <span className="text-meta leading-tight text-muted-foreground">
          {tool.line}. You sign in with {tool.name} itself; nothing is shared with anyone else.
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {action}
        <Button size="sm" variant="ghost" onClick={onDismiss} className="text-muted-foreground">
          Not now
        </Button>
      </span>
    </div>
  );
}

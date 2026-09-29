import { useMemo } from "react";
import { useConnections, useToolConnections } from "@/hooks/use-connections";
import { assetSrc } from "@/lib/api-client";
import { mergeConnectedApps } from "@/lib/connected-apps";
import { appStartersFor } from "@/lib/chat-starters";
import { AppLogo } from "@/components/integrations/app-logo";
import { PROVIDER_MARK } from "@/components/integrations/brand-marks";

/**
 * What an empty conversation can offer beyond the documents.
 *
 * A second group under the knowledge starters, because the two answer
 * different questions — "what has this agent read" and "what can it reach" —
 * and a person who has just connected Gmail is looking for the second one.
 *
 * IT OWNS ITS OWN QUERIES. The chat route has no connection data and no reason
 * to: threading two queries through it for one branch of one screen would put
 * them on every render of every conversation. They only run where this renders,
 * which is only on an empty screen — hence the `isSuccess` gate on that branch,
 * without which they would fire once per chat opened.
 *
 * THE HEADING IS INSIDE THIS COMPONENT, which is the whole of why it can return
 * null. Left in the route it would label an empty region on every workspace
 * that has connected nothing — most of them, on the day somebody signs up.
 */
export function ConnectedStarters({ onPick }: { onPick: (starter: string) => void }) {
  // Both endpoints answer with a wrapper, not a list: `connections` beside the
  // catalogue of what this deployment COULD connect, which is the Integrations
  // page's question and not this one's.
  const { data: toolData } = useToolConnections();
  const { data: sourceData } = useConnections();

  const starters = useMemo(
    () =>
      appStartersFor(
        mergeConnectedApps(toolData?.connections ?? [], sourceData?.connections ?? []),
      ),
    [toolData, sourceData],
  );

  if (starters.length === 0) return null;

  return (
    <div className="mt-10 text-left">
      <h4 className="text-xs font-medium uppercase tracking-[0.06em] text-micro-foreground">
        Connected apps
      </h4>
      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        {starters.map(({ app, starter }) => (
          <button
            key={app.slug}
            onClick={() => onPick(starter)}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-left text-sm transition-colors duration-200 hover:bg-surface-hover"
          >
            {/* Two kinds of mark, one tile. A Composio app's logo is a path on
                our own API; Notion's and Drive's are SVGs we ship, and asking
                the network for a file already in the bundle would be a request
                per row for nothing. `AppLogo` takes either. */}
            <AppLogo
              size={28}
              name={app.name}
              src={assetSrc(app.logoPath)}
              mark={app.provider ? PROVIDER_MARK[app.provider] : undefined}
            />
            <span className="min-w-0">{starter}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Blocks, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api, assetSrc } from "@/lib/api-client";
import type { ToolConnection, ToolConnectionGrant } from "@/lib/connections-api";
import { canWriteAsRole } from "@/lib/roles";
import {
  useComposioGrants,
  useComposioStatus,
  useComposioToolkits,
  useRemoveComposioGrant,
  useRemoveToolConnection,
} from "@/hooks/use-connections";
import { AppCatalogue } from "@/components/integrations/app-catalogue";
import { AppLogo } from "@/components/integrations/app-logo";
import { Chip, SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";

/**
 * The applications this workspace has connected, and the catalogue it can
 * connect more from.
 *
 * WHY THERE ARE LOGOS NOW. The first version of this file argued there could
 * not be, and the argument had three legs. Two were sound and one had stopped
 * being true. The Content Security Policy was never the obstacle — what this
 * app actually sends is `frame-ancestors 'none'` with no `img-src` at all
 * (`src/start.ts`) — so that leg was describing a header we do not have. The
 * two sound ones were that a logo per row is a request to somebody else's CDN
 * on every page view, and that a logo which 404s is worse than no logo. Both
 * are now answered rather than avoided: every mark is fetched through
 * `GET /composio/logo` on our own API, which will fetch from two allowlisted
 * hosts and nothing else, and a bad answer becomes a monogram in `AppLogo`
 * rather than a broken image. The page still speaks to nobody but us.
 *
 * WHY THE SEARCH FIELD LEFT. It was a button that opened a text field that
 * printed forty untitled rows and nothing before you typed — a tool for
 * somebody who already knew the answer. `AppCatalogue` is the replacement and
 * it is a different question: what is on offer.
 *
 * Read `DESIGN.md` before changing any of this. What it constrains here: the
 * 44px tile is the accent ceiling and a mark lives inside it at 22px, chips
 * stay neutral, and the radius ladder runs 4 chip · 8 button · 10 row · 12
 * card.
 */
export function ComposioCard({
  connections,
  agents,
}: {
  connections: ToolConnection[];
  /**
   * Only to put a name beside a standing permission. Passed in rather than
   * read from the store, because the page above already holds it and a second
   * subscription here would be a second thing to keep in step.
   */
  agents: Array<{ id: string; name: string }>;
}) {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  // The house pattern — `Me.workspace` carries no role. See settings.tsx:202.
  const myRole = me?.members.find((m) => m.id === me.user.id)?.role;
  // False until `me` loads, for the reason the Supabase card gives: a control
  // that flashes into existence and then locks is worse than one that arrives a
  // moment late.
  const canWrite = me ? canWriteAsRole(myRole) : false;

  // Asked here only to learn whether this deployment has a key at all. The
  // catalogue below asks the same question and answers the same way; react-
  // query gives them one request between them.
  const catalogue = useComposioToolkits("", "", true);

  const mine = connections.filter((c) => c.transport === "composio");
  // An application already connected is not offered again. **Only one that is
  // actually connected**: a row left `pending` by somebody who went to find an
  // API key and did not come back used to take the application out of the
  // catalogue entirely, so the one thing they would try next — search for it
  // again — answered that Covan had never heard of it. Those rows are still
  // listed above the grid, which is where they get finished or removed.
  const already = new Set(
    mine.filter((c) => c.status === "active").map((c) => c.toolkitSlug ?? ""),
  );

  // Every standing permission in the workspace, grouped by the connection it
  // is on. Unconditional rather than per-card, because it is one small read
  // and the alternative is one per connected app.
  const grants = useComposioGrants();
  const standing = new Map<string, ToolConnectionGrant[]>();
  for (const grant of grants.data?.grants ?? []) {
    if (grant.mode !== "always") continue;
    const list = standing.get(grant.connectionId);
    if (list) list.push(grant);
    else standing.set(grant.connectionId, [grant]);
  }
  const agentNames = new Map(agents.map((a) => [a.id, a.name]));

  // Not configured is a state to SHOW, not to hide. A self-hoster reading the
  // docs for a feature their own build appears not to have is the failure this
  // pattern exists to avoid — the same call `ConnectSourceCard` makes about
  // NOTION_CLIENT_ID.
  if (catalogue.data?.pages[0]?.configured === false) {
    return (
      <SectionCard className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <Tile />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="font-dm text-title font-medium leading-tight">Connected apps</span>
            <span className="text-meta leading-tight text-muted-foreground">
              Set <span className="font-mono text-xs">COMPOSIO_API_KEY</span> to let agents search
              about 1500 applications and call the ones you connect — Gmail, HubSpot, Linear.
            </span>
          </span>
        </div>
        <Chip tone="neutral">Not configured</Chip>
      </SectionCard>
    );
  }

  return (
    <SectionCard className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <Tile />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="font-dm text-title font-medium leading-tight">Connected apps</span>
            <span className="text-meta leading-tight text-muted-foreground">
              Gmail, HubSpot, Linear and about fifteen hundred others. Some need only a sign-in,
              most need a key from the application itself, and the few nobody can connect yet say
              so. An agent asks before its first action on each.
            </span>
          </span>
        </div>
        {mine.length > 0 ? <Chip tone="neutral">{mine.length} connected</Chip> : null}
      </div>

      {mine.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-t border-hairline pt-4">
          {mine.map((c) => (
            <ConnectedApp
              key={c.id}
              connection={c}
              grants={standing.get(c.id) ?? []}
              agentNames={agentNames}
              canWrite={canWrite}
            />
          ))}
        </ul>
      ) : null}

      {/* A viewer cannot connect anything, so they are not shown a grid of
          things to click. The list above stays: what the workspace already
          reaches is worth knowing whether or not you may change it. */}
      {canWrite ? (
        <div className="border-t border-hairline pt-4">
          <AppCatalogue connected={already} />
        </div>
      ) : null}
    </SectionCard>
  );
}

/**
 * One connected application, and the way back out of it.
 *
 * A row that is still `pending` polls, because a person who has just come back
 * from a consent screen should see it settle rather than reload the page to
 * find out. The poll stops the moment it is not pending — the worker writes the
 * row on the first answer, so asking again would be a request to a third party
 * for something that cannot change.
 *
 * Removing it revokes the grant at Composio before the row goes. That is the
 * whole reason removal is a route call rather than a delete: a deleted row with
 * a live grant is an OAuth token nobody in this product can see or take back.
 */
function ConnectedApp({
  connection,
  grants,
  agentNames,
  canWrite,
}: {
  connection: ToolConnection;
  grants: ToolConnectionGrant[];
  agentNames: Map<string, string>;
  canWrite: boolean;
}) {
  const remove = useRemoveToolConnection();
  const [confirming, setConfirming] = useState(false);
  useComposioStatus(connection.id, connection.status === "pending");

  return (
    // The standing permissions live INSIDE the row's box, not under it. Put
    // outside they read as a third item between two applications, which is
    // exactly what they are not — each one belongs to the application above
    // it, and a list where that is ambiguous is worse than no list.
    <li className="flex flex-col gap-2 rounded-lg border border-hairline bg-background px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="flex min-w-0 flex-1 basis-40 items-center gap-3">
          <AppLogo src={assetSrc(connection.logoPath)} name={connection.label} size={36} />
          <span className="flex min-w-0 flex-col gap-[2px]">
            <span className="truncate">{connection.label}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {connection.toolkitSlug}
            </span>
          </span>
          {connection.status === "pending" ? (
            <Chip tone="neutral">Finishing…</Chip>
          ) : connection.status === "failed" ? (
            <Chip tone="neutral">Not connected</Chip>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {canWrite ? (
            confirming ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    remove.mutate(connection.id, {
                      onSuccess: () => toast.success(`${connection.label} disconnected.`),
                      onError: (err) =>
                        toast.error(err instanceof Error ? err.message : "Could not remove that"),
                    })
                  }
                >
                  {remove.isPending ? "Removing…" : "Remove"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Remove
              </Button>
            )
          ) : null}
        </span>
      </div>

      {/* Only the standing permissions are listed, because only they are a
          thing somebody granted. Everything else on this app asks, and there
          is no row saying so — the absence of one IS the asking (0063). A list
          that printed "asks first" for every operation in a 1500-app catalogue
          would be a list of everything. */}
      {grants.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-hairline pt-2">
          {grants.map((grant) => (
            <StandingGrant
              key={`${grant.agentId}:${grant.slug}`}
              grant={grant}
              agentName={agentNames.get(grant.agentId) ?? "an agent"}
              canWrite={canWrite}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * One permission an agent was given in advance, and the way back out of it.
 *
 * Removal is an ordinary writer's, not an admin's, and the asymmetry is
 * 0058's: a writer who cannot raise a grant to `always` must still be able to
 * lower one from it, or the only people who could take a standing permission
 * away would be the people who could give it. That gets the direction of
 * caution exactly backwards.
 *
 * No confirmation step, unlike disconnecting the app above. Removing a
 * permission cannot be the unsafe direction, and a card that asks "are you
 * sure?" before making something safer teaches people to click through the
 * question that matters.
 */
function StandingGrant({
  grant,
  agentName,
  canWrite,
}: {
  grant: ToolConnectionGrant;
  agentName: string;
  canWrite: boolean;
}) {
  const revoke = useRemoveComposioGrant();
  return (
    <li className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        <span className="font-mono">{grant.slug}</span> · {agentName} runs this without asking
      </span>
      {canWrite ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={revoke.isPending}
          onClick={() =>
            revoke.mutate(
              {
                agentId: grant.agentId,
                connectionId: grant.connectionId,
                slug: grant.slug,
              },
              {
                onSuccess: () => toast.success(`${agentName} will ask before ${grant.slug}.`),
                onError: (err) =>
                  toast.error(err instanceof Error ? err.message : "Could not remove that"),
              },
            )
          }
        >
          Ask first
        </Button>
      ) : null}
    </li>
  );
}

/** The 44px mark every row on this page carries. See DESIGN.md. */
function Tile() {
  return (
    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline">
      <Blocks className="h-[22px] w-[22px]" />
    </span>
  );
}

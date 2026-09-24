import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Blocks, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import type { ToolConnection, ToolConnectionGrant } from "@/lib/connections-api";
import { canWriteAsRole } from "@/lib/roles";
import {
  useComposioGrants,
  useComposioStatus,
  useComposioToolkits,
  useConnectComposio,
  useRemoveComposioGrant,
  useRemoveToolConnection,
} from "@/hooks/use-connections";
import { Chip, SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * About fifteen hundred applications, and the search that is the only sane way
 * to offer them.
 *
 * Every other card on this page is one row per connectable thing, which works
 * at four and does not work here. So this is a search field: a person types
 * "hubspot", picks it, completes a consent screen at HubSpot, and comes back to
 * a connected application their agents can call.
 *
 * WHY THERE ARE NO LOGOS. `brand-marks.tsx` is inline SVG so the page loads
 * nothing off-origin, and fifteen hundred logos cannot be — a remote logo per
 * row would be fifteen hundred requests to somebody else's CDN and a Content
 * Security Policy change to allow them. The neutral 44px tile that every row on
 * this page already carries does the job (DESIGN.md), and the application's
 * name is what a person is reading anyway.
 *
 * Read `DESIGN.md` before changing any of this. What it constrains here: the
 * 44px tile is the accent ceiling and holds a neutral mark, chips stay neutral,
 * and the radius ladder runs 4 chip · 8 button · 10 row · 12 card.
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

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const catalogue = useComposioToolkits(query.trim(), searching);
  const connect = useConnectComposio();

  const mine = connections.filter((c) => c.transport === "composio");
  // An application already connected is not offered again: the label is unique
  // per workspace, so picking it would fail on the way back with a message
  // about a name rather than about what happened.
  const already = new Set(mine.map((c) => c.toolkitSlug));
  const offered = (catalogue.data?.toolkits ?? []).filter((t) => !already.has(t.slug));

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
  if (catalogue.data?.configured === false) {
    return (
      <SectionCard className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <Tile />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="font-dm text-title font-medium leading-tight">Connected apps</span>
            <span className="text-meta leading-tight text-muted-foreground">
              Set <span className="font-mono text-xs">COMPOSIO_API_KEY</span> to let agents call
              Gmail, HubSpot, Linear and about 1500 more.
            </span>
          </span>
        </div>
        <Chip tone="neutral">Not configured</Chip>
      </SectionCard>
    );
  }

  return (
    <SectionCard className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <Tile />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="font-dm text-title font-medium leading-tight">Connected apps</span>
            <span className="text-meta leading-tight text-muted-foreground">
              Gmail, HubSpot, Linear and about 1500 more. An agent asks before its first action on
              each one.
            </span>
          </span>
        </div>
      </div>

      {mine.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-t border-hairline pt-3">
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

      {canWrite && !searching ? (
        <div>
          <Button variant="outline" onClick={() => setSearching(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Connect an app
          </Button>
        </div>
      ) : null}

      {searching ? (
        <div className="flex flex-col gap-3 border-t border-hairline pt-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="composio-search">Find an app</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="composio-search"
                className="pl-8"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="gmail, hubspot, linear…"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              You sign in at the app itself. Covan never sees the password or the token — the grant
              is held by Composio, and what is stored here is a reference to it.
            </p>
          </div>

          {catalogue.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : offered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {query.trim()
                ? `Nothing in the catalogue matches “${query.trim()}”.`
                : "Type to search the catalogue."}
            </p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {offered.slice(0, 40).map((toolkit) => (
                <li key={toolkit.slug}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-[10px] px-2.5 py-2 text-left hover:bg-surface"
                    disabled={connect.isPending}
                    onClick={() =>
                      connect.mutate(
                        { toolkit: toolkit.slug, label: toolkit.name },
                        {
                          onError: (err: Error) => toast.error(err.message),
                        },
                      )
                    }
                  >
                    <span className="flex min-w-0 flex-col gap-[2px]">
                      <span className="truncate text-sm">{toolkit.name}</span>
                      {toolkit.description ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {toolkit.description}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">Connect</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div>
            <Button
              variant="ghost"
              onClick={() => {
                setSearching(false);
                setQuery("");
              }}
            >
              Cancel
            </Button>
          </div>
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
    <li className="flex flex-col gap-1.5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{connection.label}</span>
          {connection.status === "pending" ? (
            <Chip tone="neutral">Finishing…</Chip>
          ) : connection.status === "failed" ? (
            <Chip tone="neutral">Not connected</Chip>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{connection.toolkitSlug}</span>
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
          is no row saying so — the absence of one IS the asking (0062). A list
          that printed "asks first" for every operation in a 1500-app catalogue
          would be a list of everything. */}
      {grants.length > 0 ? (
        <ul className="flex flex-col gap-1 border-l border-hairline pl-2.5">
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

import { useState } from "react";
import { toast } from "sonner";
import { Blocks, Database, Globe, Trash2 } from "lucide-react";
import type { ToolAvailability, ToolConnection } from "@/lib/connections-api";
import { Button } from "@/components/ui/button";
import { Chip, Disclosure, SectionCard } from "@/components/section-card";
import { useRemoveToolConnection } from "@/hooks/use-connections";

/**
 * A service an agent can call: one row, and the way back out of it.
 *
 * WHY THIS IS A ROW AND NOT A CARD. It used to be a full-width `SectionCard`
 * per connection, stacked under two other cards that each held a list of
 * their own — a card containing a list of cards containing lists, which is
 * what made the Integrations page unreadable. These now sit inside the one
 * "connected" panel with everything else the workspace has connected, at the
 * same density as a Composio application or a Supabase project.
 *
 * The form that creates one moved out to `add-service-dialog.tsx` at the same
 * time, and for the same reason: it expanded in place and moved everything
 * below it.
 *
 * Read `DESIGN.md` before changing any of this. What it constrains here: the
 * 44px tile is the accent ceiling and holds a neutral mark, the chips are
 * neutral (a chip never carries the destructive tone), and the radius ladder
 * runs 4 chip · 8 button · 10 row · 12 card — a child is never tighter than
 * its parent.
 */
export function ToolConnectionCard({ connection }: { connection: ToolConnection }) {
  const remove = useRemoveToolConnection();
  const [confirming, setConfirming] = useState(false);
  // Three kinds now, and the third is defensive rather than reachable: a
  // `composio` row is listed inside the card that connected it, the way a
  // Supabase project is, so this list never holds one. Named anyway, because
  // the alternative is a connected application silently drawn as a Database if
  // that filtering ever changes.
  const Mark =
    connection.transport === "http"
      ? Globe
      : connection.transport === "composio"
        ? Blocks
        : Database;
  // Anything past GET and HEAD changes something at the other end, which is
  // the one fact about a connection worth putting on the row. Said in words
  // rather than in colour: a chip stays neutral-or-amber, and amber here
  // would be five pointers on a page that should have one.
  const writes = connection.allowedMethods.some((m) => !["GET", "HEAD"].includes(m));

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-hairline bg-background px-3 py-2.5">
      {/* Wraps rather than truncates. Three chips and a Remove button do not
          fit beside a name at 390px, and `shrink-0` on the trailing group
          means the name is what gives way — so at phone width the row used to
          be a line of chips belonging to nothing. */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-44 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface text-muted-foreground ring-1 ring-inset ring-hairline">
            <Mark className="h-[18px] w-[18px]" />
          </span>
          <span className="flex min-w-0 flex-col gap-[2px]">
            <span className="truncate text-sm [overflow-wrap:anywhere]">{connection.label}</span>
            <span className="truncate text-xs leading-tight text-muted-foreground [overflow-wrap:anywhere]">
              {connection.baseUrl}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Chip tone="neutral">
            {connection.transport === "http"
              ? "HTTP API"
              : connection.transport === "composio"
                ? "Connected app"
                : "Database"}
          </Chip>
          {writes ? <Chip tone="neutral">Can write</Chip> : <Chip tone="neutral">Read only</Chip>}
          {confirming ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  remove.mutate(connection.id, {
                    onSuccess: () => toast.success(`${connection.label} removed.`),
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
          )}
        </div>
      </div>

      {confirming ? (
        <p className="text-xs text-muted-foreground">
          Remove it? Agents lose this service immediately.
        </p>
      ) : null}

      {/* What the agent is told about this connection, which is the one thing
          here somebody occasionally needs and never needs twice. Folded, for
          the reason `Disclosure` exists: the row says what the thing is, and
          this says how it works. */}
      <Disclosure
        label={
          connection.transport === "sql"
            ? `Read through ${connection.rpc ?? "covan_query"}`
            : `Allowed methods: ${connection.allowedMethods.join(", ") || "none"}`
        }
      >
        {connection.transport === "sql" ? (
          <p>
            The agent&apos;s SQL runs inside{" "}
            <span className="font-mono">{connection.rpc ?? "covan_query"}</span>, and that function
            is what decides whether it can write — the method is a POST either way.
          </p>
        ) : (
          <p>
            Every request stays inside <span className="font-mono">{connection.baseUrl}</span>. The
            agent names a path, never a URL, and cannot widen the method list.
          </p>
        )}
        {connection.summary ? (
          <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap">{connection.summary}</p>
        ) : null}
      </Disclosure>
    </li>
  );
}

/**
 * What an agent can actually do, listed rather than left to the docs.
 *
 * Every tool this build has, configured or not — the same rule
 * `ConnectSourceCard` follows for a provider with no credentials, and for the
 * same reason: a self-hoster reading the docs for a feature their own build
 * appears not to have is the failure that pattern exists to avoid.
 *
 * "Can change things" is the one fact worth putting on a row here, and it is
 * a word rather than a colour: a chip is never destructive, and amber on six
 * rows would be six pointers pointing nowhere.
 *
 * Folded, and it was not before. Eight tools with a sentence each is a screen
 * of text at the bottom of a page whose subject is connections — it is the
 * sentence somebody needs once, which is exactly what `Disclosure` is for.
 * Bare rather than wrapped in a card of its own, because a disclosure is a
 * muted box that belongs inside one; the page puts it in the panel the
 * connections are already in.
 */
export function ToolList({ tools }: { tools: ToolAvailability[] }) {
  if (tools.length === 0) return null;
  return (
    <Disclosure label="What an agent can do with these">
      <ul className="flex flex-col gap-2.5 py-1">
        {tools.map((tool) => (
          <li key={tool.name} className="flex items-start gap-2.5">
            <span
              className={`mt-[6px] h-2 w-2 shrink-0 rounded-[2px] ${
                tool.configured ? "bg-foreground" : "bg-muted-foreground/40"
              }`}
            />
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs">{tool.name}</span>
                {tool.destructive ? <Chip tone="neutral">Can change things</Chip> : null}
                {tool.configured ? null : <Chip tone="neutral">Not configured here</Chip>}
              </span>
              <span className="text-meta leading-[1.45] text-muted-foreground">
                {tool.description}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

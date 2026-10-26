import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Database, Globe } from "lucide-react";
import { Trans, useTranslation } from "@/i18n";
import { scopeWords, type ToolAvailability, type ToolConnection } from "@/lib/connections-api";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/chip";
import { Disclosure } from "@/components/disclosure";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConnectionGrants, useRemoveToolConnection } from "@/hooks/use-connections";
import { api } from "@/lib/api-client";
import { canWriteAsRole } from "@/lib/roles";
import { StandingGrants } from "./composio-card";
import { ConnectionScope } from "./connection-scope";
import { IntegrationRow } from "./integration-row";

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
export function ToolConnectionRow({
  connection,
  agents = [],
}: {
  connection: ToolConnection;
  /** Only to put a name beside a standing permission. */
  agents?: Array<{ id: string; name: string }>;
}) {
  const { t } = useTranslation();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const canWrite = me ? canWriteAsRole(me.members.find((m) => m.id === me.user.id)?.role) : false;
  // Who writes here without asking (0140). A database is read-only by
  // construction, so only an HTTP service that may write has any.
  const grants = (useConnectionGrants().data?.grants ?? []).filter(
    (g) => g.connectionId === connection.id,
  );
  const remove = useRemoveToolConnection();
  const [managing, setManaging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const Mark = connection.transport === "http" ? Globe : Database;
  const writes = connection.allowedMethods.some((m) => !["GET", "HEAD"].includes(m));
  const kind = connection.transport === "http" ? t("HTTP API") : t("Database");
  const rpc = connection.rpc ?? "covan_query";

  return (
    <>
      <IntegrationRow
        logo={
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-chip-foreground">
            <Mark className="size-[18px]" aria-hidden />
          </span>
        }
        name={connection.label}
        description={[
          kind,
          connection.baseUrl,
          writes ? t("can write") : t("read only"),
          scopeWords(connection, t),
        ].join(" · ")}
        status={{ state: "done", text: t("Working") }}
        action={
          <Button size="sm" variant="secondary" onClick={() => setManaging(true)}>
            {t("Manage")}
          </Button>
        }
      />

      <Dialog
        open={managing}
        onOpenChange={(v) => {
          setManaging(v);
          if (!v) setConfirming(false);
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{connection.label}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip>{kind}</Chip>
              <Chip>{writes ? t("Can write") : t("Read only")}</Chip>
              <Chip tone="code">{connection.baseUrl}</Chip>
            </div>

            {/* What the agent is told about this connection: the one thing
                here somebody occasionally needs and never needs twice. */}
            <Disclosure
              label={
                connection.transport === "sql"
                  ? t("Read through {{rpc}}", { rpc })
                  : t("Allowed methods: {{methods}}", {
                      methods: connection.allowedMethods.join(", ") || t("none"),
                    })
              }
            >
              {connection.transport === "sql" ? (
                <p className="m-0">
                  <Trans
                    t={t}
                    i18nKey="The agent's SQL runs inside <code>{{rpc}}</code>, and that function is what decides whether it can write — the method is a POST either way."
                    values={{ rpc }}
                    components={{ code: <span className="font-mono" /> }}
                  />
                </p>
              ) : (
                <p className="m-0">
                  <Trans
                    t={t}
                    i18nKey="Every request stays inside <code>{{url}}</code>. The agent names a path, never a URL, and cannot widen the method list."
                    values={{ url: connection.baseUrl }}
                    components={{ code: <span className="font-mono" /> }}
                  />
                </p>
              )}
              {connection.summary ? (
                <p className="mt-2 mb-0 max-h-24 overflow-y-auto whitespace-pre-wrap">
                  {connection.summary}
                </p>
              ) : null}
            </Disclosure>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t("Who can use it")}</span>
              <ConnectionScope connection={connection} />
            </div>

            {connection.transport === "http" && writes ? (
              <StandingGrants
                grants={grants}
                agentNames={new Map(agents.map((a) => [a.id, a.name]))}
                appName={connection.label}
                canWrite={canWrite}
              />
            ) : null}

            <div className="flex items-center gap-2 border-t border-hairline pt-3">
              {confirming ? (
                <>
                  <span className="flex-1 text-meta text-muted-foreground">
                    {t("Remove it? Agents lose this service immediately.")}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                    {t("Keep")}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() =>
                      remove.mutate(connection.id, {
                        onSuccess: () => {
                          setManaging(false);
                          toast.success(t("{{app}} removed.", { app: connection.label }));
                        },
                        onError: (err) =>
                          toast.error(
                            err instanceof Error ? err.message : t("Could not remove that"),
                          ),
                      })
                    }
                  >
                    {remove.isPending ? t("Removing…") : t("Remove")}
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setConfirming(true)}
                >
                  {t("Remove {{app}}…", { app: connection.label })}
                </Button>
              )}
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
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
  const { t } = useTranslation();
  if (tools.length === 0) return null;
  return (
    <Disclosure label={t("What an agent can do with these")}>
      <ul className="flex flex-col gap-2.5 py-1">
        {tools.map((tool) => (
          <li key={tool.name} className="flex items-start gap-2.5">
            <span
              className={`mt-[6px] h-2 w-2 shrink-0 rounded-full ${
                tool.configured ? "bg-foreground" : "bg-muted-foreground/40"
              }`}
            />
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs">{tool.name}</span>
                {tool.destructive ? <Chip size="sm">{t("Can change things")}</Chip> : null}
                {tool.configured ? null : <Chip size="sm">{t("Not configured here")}</Chip>}
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

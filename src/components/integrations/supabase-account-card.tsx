import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import type { ToolConnection } from "@/lib/connections-api";
import { canWriteAsRole, isAdminRole } from "@/lib/roles";
import {
  useAddSupabaseProjects,
  useConnectSupabaseAccount,
  useDisconnectSupabaseAccount,
  useRemoveToolConnection,
  useSupabaseAccount,
  useSupabaseProjects,
} from "@/hooks/use-connections";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The other road to a database, and the short one.
 *
 * The form below this card connects a Postgres the way 0059 built it: a
 * PostgREST base, two headers, and a function installed in the target
 * database first. This one asks for a Supabase account token and installs
 * nothing — Supabase runs the statement itself, as a read-only role. Both
 * stay, because they ask for different things: one wants a credential, the
 * other wants a migration, and which is easier to give is not ours to decide.
 *
 * WHY THE TOKEN IS AN ADMIN'S. It is account-wide — it opens every project in
 * that Supabase account, not only the ones ticked here. That is the same
 * argument `WorkspaceProviderKeys` makes about an OpenAI key, and it is
 * settled the same way. Choosing which projects an agent may read is an
 * ordinary write, because by then the decision that mattered has been made.
 */
export function SupabaseAccountCard({ connections }: { connections: ToolConnection[] }) {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data } = useSupabaseAccount();
  const account = data?.account ?? null;

  // The house pattern — `Me.workspace` carries no role. See settings.tsx:202.
  const myRole = me?.members.find((m) => m.id === me.user.id)?.role;
  // False until `me` loads, for the reason `WorkspaceProviderKeys` gives: a
  // token field that flashes into existence and then locks is worse than one
  // that arrives a moment late.
  const isAdmin = me ? isAdminRole(myRole) : false;
  const canWrite = me ? canWriteAsRole(myRole) : false;

  const connect = useConnectSupabaseAccount();
  const add = useAddSupabaseProjects();
  const disconnect = useDisconnectSupabaseAccount();

  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [picking, setPicking] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);

  const projects = useSupabaseProjects(picking && Boolean(account));

  const mine = connections.filter((c) => c.transport === "supabase" && c.accountId === account?.id);
  const already = new Set(mine.map((c) => c.projectRef));
  // A project already connected is not offered again: the label is unique per
  // workspace, so ticking it would fail on the way back with a message about
  // a name rather than about what happened.
  const offered = (projects.data?.projects ?? []).filter((p) => !already.has(p.ref));

  const closePicker = () => {
    setPicking(false);
    setTicked([]);
  };

  const submitToken = () => {
    connect.mutate(
      { token: token.trim() },
      {
        onSuccess: () => {
          toast.success("Supabase account connected");
          setToken("");
          setOpen(false);
          setPicking(true);
        },
        onError: (err: Error) => toast.error(err.message),
      },
    );
  };

  const submitProjects = () => {
    add.mutate(
      { refs: ticked },
      {
        onSuccess: () => {
          toast.success(ticked.length === 1 ? "Project connected" : "Projects connected");
          closePicker();
        },
        onError: (err: Error) => toast.error(err.message),
      },
    );
  };

  if (!account) {
    if (!isAdmin) {
      return (
        <SectionCard className="flex items-center gap-3">
          <Tile />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="font-dm text-title font-medium leading-tight">Supabase</span>
            <span className="text-meta leading-tight text-muted-foreground">
              An admin of this workspace can connect a Supabase account, and agents can then query
              its projects.
            </span>
          </span>
        </SectionCard>
      );
    }

    if (!open) {
      return (
        <SectionCard className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-3">
            <Tile />
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="font-dm text-title font-medium leading-tight">Supabase</span>
              <span className="text-meta leading-tight text-muted-foreground">
                Connect your account and pick projects. Nothing to install in them.
              </span>
            </span>
          </span>
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Connect
          </Button>
        </SectionCard>
      );
    }

    return (
      <SectionCard className="flex flex-col gap-5">
        <span className="font-dm text-title font-medium leading-tight">Connect Supabase</span>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sa-token">Access token</Label>
          <Input
            id="sa-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="sbp_..."
          />
          <p className="text-xs text-muted-foreground">
            From Supabase, under Account settings → Access tokens. It reaches every project in that
            account; agents here read only the ones you tick.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={submitToken} disabled={token.trim().length < 20 || connect.isPending}>
            Connect
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setToken("");
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <Tile />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="font-dm text-title font-medium leading-tight">Supabase</span>
            <span className="text-meta leading-tight text-muted-foreground">
              Connected with <span className="font-mono text-xs">{account.tokenHint}</span>
            </span>
          </span>
        </span>
        {isAdmin ? (
          <Button
            variant="ghost"
            onClick={() =>
              disconnect.mutate(undefined, {
                onSuccess: () => toast.success("Supabase account disconnected"),
                onError: (err: Error) => toast.error(err.message),
              })
            }
            disabled={disconnect.isPending}
          >
            Disconnect
          </Button>
        ) : null}
      </div>

      {mine.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-t border-hairline pt-3">
          {mine.map((c) => (
            <ConnectedProject key={c.id} connection={c} canWrite={canWrite} />
          ))}
        </ul>
      ) : (
        <p className="border-t border-hairline pt-3 text-sm text-muted-foreground">
          No projects connected yet. Agents cannot reach this account until one is.
        </p>
      )}

      {canWrite && !picking ? (
        <div>
          <Button variant="outline" onClick={() => setPicking(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add a project
          </Button>
        </div>
      ) : null}

      {picking ? (
        <div className="flex flex-col gap-3 border-t border-hairline pt-3">
          {projects.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : offered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every project this account can see is already connected.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {offered.map((p) => (
                <li key={p.ref} className="flex items-center gap-2.5">
                  <Checkbox
                    id={`sa-${p.ref}`}
                    checked={ticked.includes(p.ref)}
                    onCheckedChange={(on) =>
                      setTicked((was) =>
                        on === true ? [...was, p.ref] : was.filter((r) => r !== p.ref),
                      )
                    }
                  />
                  <Label htmlFor={`sa-${p.ref}`} className="flex min-w-0 flex-col gap-[2px]">
                    <span className="truncate">{p.name}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {p.region}
                      {p.status && p.status !== "ACTIVE_HEALTHY" ? ` · ${p.status}` : ""}
                    </span>
                  </Label>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2">
            <Button onClick={submitProjects} disabled={ticked.length === 0 || add.isPending}>
              {ticked.length === 1 ? "Connect 1 project" : `Connect ${ticked.length} projects`}
            </Button>
            <Button variant="ghost" onClick={closePicker}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

/**
 * One connected project, and the way back out of it.
 *
 * Disconnecting the account takes every project with it — that is 0061's
 * cascade and it is the right default — so dropping one has to be possible
 * without dropping all of them. It is an ordinary `tool_connections` delete,
 * the same one the service list uses, confirmed in place rather than through a
 * dialog for the reason the card below it does the same.
 */
function ConnectedProject({
  connection,
  canWrite,
}: {
  connection: ToolConnection;
  canWrite: boolean;
}) {
  const remove = useRemoveToolConnection();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="truncate">{connection.label}</span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{connection.projectRef}</span>
        {canWrite ? (
          confirming ? (
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
          )
        ) : null}
      </span>
    </li>
  );
}

/** The 44px mark every row on this page carries. See DESIGN.md. */
function Tile() {
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-inset ring-hairline">
      <Database className="h-5 w-5 text-muted-foreground" />
    </span>
  );
}

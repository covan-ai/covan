import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { invalidateWorkspaceScoped } from "@/lib/workspace-queries";
import { Tile } from "@/components/tile";
import { workspaceIconSrc } from "@/lib/workspace-icon-src";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The workspace you are in, at the top of the sidebar (DESIGN.md §6): its
 * ink tile and name, and the menu that moves you to another or makes one.
 */
export function WorkspaceSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.workspaces.list(),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const current = me?.workspace;

  const switchTo = async (id: string) => {
    if (id === current?.id) return;
    try {
      await api.workspace.setActive(id);
      await invalidateWorkspaceScoped(queryClient);
      onNavigate?.();
      void navigate({ to: "/app" });
    } catch {
      toast.error("Couldn't switch workspace.");
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      await api.workspaces.create(trimmed);
      await invalidateWorkspaceScoped(queryClient);
      setCreateOpen(false);
      setName("");
      toast.success("Workspace created");
      void navigate({ to: "/app" });
    } catch {
      toast.error("Couldn't create workspace.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Switch workspace"
            className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-sidebar-hover"
          >
            <Tile
              label={current?.name ?? "…"}
              tone="ink"
              imageUrl={workspaceIconSrc(current?.iconUrl)}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {current?.name ?? "…"}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-micro-foreground" strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
            Workspaces
          </DropdownMenuLabel>
          {workspaces.map((w) => (
            <DropdownMenuItem key={w.id} onClick={() => void switchTo(w.id)}>
              <Tile label={w.name} tone={w.id === current?.id ? "ink" : "neutral"} />
              <span className="flex-1 truncate">{w.name}</span>
              {w.id === current?.id && <Check className="size-4 shrink-0" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" /> Create workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Create workspace</DialogTitle>
            <DialogDescription>
              A separate space with its own agents, knowledge and members.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Input
              autoFocus
              aria-label="Workspace name"
              placeholder="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!name.trim() || creating}>
              {creating ? "Creating…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

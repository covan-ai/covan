import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, type WorkspaceMember } from "@/lib/api-client";
import { useAgentsStore, type Agent } from "@/lib/agents-store";
import {
  ACCESS_HINT,
  ACCESS_LABEL,
  AGENT_ACCESS,
  accessRank,
  cappedByRole,
  sharingFor,
  sharingMode,
  type AgentAccess,
  type AgentShare,
  type SharingMode,
} from "@/lib/agent-access";
import { isAdminRole } from "@/lib/roles";
import { AgentMark } from "@/components/agent-mark";
import { Avatar } from "@/components/avatar";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Who can reach an agent, and how far.
 *
 * The dialog owns nothing but whether it is open, for the reason
 * `CreateAgentDialog` gives: the form below mounts with the dialog, so every
 * opening starts from the agent as the server has it, with nothing to reset.
 *
 * Offered only to somebody with Full access — the server refuses everyone
 * else, so the button that opens this is not on their screen at all.
 */
export function ShareAgentDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className="max-h-[90vh] overflow-y-auto">
        <ShareAgentForm agent={agent} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ShareAgentForm({ agent, onDone }: { agent: Agent; onDone: () => void }) {
  const { setSharing } = useAgentsStore();
  // Already in the cache; every authed page fills it. `members` is the
  // workspace, which is everybody this agent could be shared with.
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const members = me?.members ?? [];
  const myId = me?.user.id;

  const [mode, setMode] = useState<SharingMode>(() => sharingMode(agent));
  // The level the workspace option shows before anybody has picked one. Can
  // use, because widening an agent to everyone is the moment to be cautious
  // about what everyone can change.
  const [workspaceLevel, setWorkspaceLevel] = useState<AgentAccess>(agent.workspaceAccess ?? "use");
  const [shares, setShares] = useState<AgentShare[]>(agent.shares);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);

  const byId = new Map(members.map((m) => [m.id, m]));
  const owner = agent.createdBy ? byId.get(agent.createdBy) : undefined;
  const sharedIds = new Set(shares.map((s) => s.userId));
  // Admins always have Full access and need no row, so they are listed as a
  // fact rather than offered as a choice — unless one already has a row, which
  // the server allows, in which case that row is where they appear.
  const admins = members.filter(
    (m) => isAdminRole(m.role) && m.id !== agent.createdBy && !sharedIds.has(m.id),
  );
  // Everybody a share would mean something for: not the owner (the server
  // refuses that row), not an admin, and not somebody already on the list.
  const candidates = members.filter(
    (m) => m.id !== agent.createdBy && !isAdminRole(m.role) && !sharedIds.has(m.id),
  );

  // In the workspace mode a share only matters if it is above what everyone
  // already has, so nobody can be added once everyone has Full access.
  const floor = mode === "workspace" ? accessRank(workspaceLevel) : 0;
  const canAdd = mode !== "only" && floor < AGENT_ACCESS.length;

  const add = (member: WorkspaceMember) => {
    // One step above what everyone has, so adding somebody always does
    // something. A viewer starts at Can use, which is all they can have.
    const access: AgentAccess =
      member.role === "viewer" ? "use" : AGENT_ACCESS[Math.min(floor, AGENT_ACCESS.length - 1)];
    setShares((prev) => [...prev, { userId: member.id, access }]);
    setPicking(false);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await setSharing(agent.id, sharingFor(mode, workspaceLevel, shares));
      toast.success("Sharing saved");
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save who can use it.");
      setSaving(false);
    }
  };

  const ownerIsMe = !!agent.createdBy && agent.createdBy === myId;
  const options: { key: SharingMode; label: string; hint: string }[] = [
    {
      key: "only",
      label: ownerIsMe ? "Only me" : "Only the owner",
      hint: ownerIsMe
        ? "Nobody else sees it. Workspace admins can still reach it."
        : "Nobody but its owner and the workspace admins sees it.",
    },
    { key: "people", label: "Specific people", hint: "Only the people you add below." },
    {
      key: "workspace",
      label: `Everyone in ${me?.workspace.name ?? "the workspace"}`,
      hint: "Including people who join later.",
    },
  ];

  const chosen = options.find((o) => o.key === mode)!;

  return (
    <>
      <DialogHeader>
        <span className="flex items-center gap-2.5">
          <AgentMark agent={agent} size={24} />
          <DialogTitle>Share {agent.name}</DialogTitle>
        </span>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <div className="space-y-1.5">
          <Label>Who can use it</Label>
          <div className="flex gap-2">
            <Select value={mode} onValueChange={(v) => setMode(v as SharingMode)}>
              <SelectTrigger aria-label="Who can use it" className="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.key} value={o.key}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {mode === "workspace" ? (
              <LevelSelect
                value={workspaceLevel}
                onChange={setWorkspaceLevel}
                label="What everyone in the workspace can do"
              />
            ) : null}
          </div>
          <p className="m-0 text-meta text-muted-foreground">
            {chosen.hint} Threads stay private to whoever starts them, shared or not.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">People with access</span>
            {canAdd && candidates.length > 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setPicking(true)}>
                <UserPlus /> Add a person
              </Button>
            ) : null}
          </div>

          <ul className="m-0 mt-1 list-none p-0">
            <FixedRow
              member={owner}
              fallbackName={agent.createdBy ? "The owner" : null}
              you={ownerIsMe}
              note="Owner"
            />
            {admins.map((m) => (
              <FixedRow
                key={m.id}
                member={m}
                you={m.id === myId}
                note="Admin · always has full access"
              />
            ))}
            {mode === "only"
              ? null
              : shares.map((share) => (
                  <ShareRow
                    key={share.userId}
                    share={share}
                    member={byId.get(share.userId)}
                    you={share.userId === myId}
                    floor={floor}
                    onChange={(access) =>
                      setShares((prev) =>
                        prev.map((s) => (s.userId === share.userId ? { ...s, access } : s)),
                      )
                    }
                    onRemove={() =>
                      setShares((prev) => prev.filter((s) => s.userId !== share.userId))
                    }
                  />
                ))}
          </ul>

          {mode === "people" && shares.length === 0 ? (
            <p className="mt-2 mb-0 text-meta text-muted-foreground">
              Nobody added yet, so for now this is the same as{" "}
              {ownerIsMe ? "Only me" : "Only the owner"}.
            </p>
          ) : null}
          {canAdd && candidates.length === 0 && members.length > 0 ? (
            <p className="mt-2 mb-0 text-meta text-muted-foreground">
              Everybody else in the workspace is already listed.
            </p>
          ) : null}
        </div>

        <p className="m-0 text-meta text-muted-foreground">
          Taking someone off hides the agent from them, with their threads and routines on it.
          Nothing is deleted, and it all comes back if you share it again.
        </p>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>

      <CommandDialog open={picking} onOpenChange={setPicking}>
        <CommandInput placeholder="Search people by name or email…" />
        <CommandList>
          <CommandEmpty>Nobody by that name.</CommandEmpty>
          <CommandGroup heading={me?.workspace.name ?? "Workspace"}>
            {candidates.map((m) => (
              <CommandItem
                key={m.id}
                // cmdk filters on this, so it carries everything somebody
                // might type — and the id, so two people with one name stay
                // two items.
                value={`${m.name ?? ""} ${m.email ?? ""} ${m.id}`}
                onSelect={() => add(m)}
              >
                <Avatar name={m.name ?? m.email} url={m.avatarUrl} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{m.name ?? m.email ?? "Unnamed member"}</span>
                  {m.name && m.email ? (
                    <span className="block truncate text-meta text-muted-foreground">
                      {m.email}
                    </span>
                  ) : null}
                </span>
                {m.role === "viewer" ? (
                  <span className="text-xs text-muted-foreground">Viewer</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

/** Somebody who has Full access without a row: the owner, or an admin. */
function FixedRow({
  member,
  fallbackName,
  you,
  note,
}: {
  member: WorkspaceMember | undefined;
  /** What to call them when `members` does not have them; null hides the row. */
  fallbackName?: string | null;
  you: boolean;
  note: string;
}) {
  if (!member && !fallbackName) return null;
  return (
    <li className="flex min-h-11 items-center gap-3 border-b border-hairline py-1.5 last:border-b-0">
      <PersonLabel member={member} fallbackName={fallbackName ?? null} you={you} />
      <span className="shrink-0 text-right text-meta text-muted-foreground">{note}</span>
    </li>
  );
}

function ShareRow({
  share,
  member,
  you,
  floor,
  onChange,
  onRemove,
}: {
  share: AgentShare;
  member: WorkspaceMember | undefined;
  you: boolean;
  /** What everyone already has, as a rank; 0 outside the workspace mode. */
  floor: number;
  onChange: (access: AgentAccess) => void;
  onRemove: () => void;
}) {
  const capped = cappedByRole(member?.role, share.access);
  const redundant = !capped && floor > 0 && accessRank(share.access) <= floor;
  const name = member?.name ?? member?.email ?? "A former member";
  return (
    <li className="flex min-h-11 items-center gap-3 border-b border-hairline py-1.5 last:border-b-0">
      <PersonLabel
        member={member}
        fallbackName="A former member"
        you={you}
        note={
          capped
            ? "Viewers can only use agents"
            : redundant
              ? "Everyone already has this"
              : undefined
        }
      />
      <LevelSelect value={share.access} onChange={onChange} label={`What ${name} can do`} />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        title={`Remove ${name}`}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-surface-hover hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </li>
  );
}

function PersonLabel({
  member,
  fallbackName,
  you,
  note,
}: {
  member: WorkspaceMember | undefined;
  fallbackName: string | null;
  you: boolean;
  note?: string;
}) {
  const name = member?.name ?? member?.email ?? fallbackName ?? "";
  // The second line is the email when there is a name to put above it, and the
  // note when there is one — the note is the thing this row needs to say.
  const second = note ?? (member?.name && member.email ? member.email : null);
  return (
    <>
      <Avatar name={name} url={member?.avatarUrl} size={24} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {name}
          {you ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
        </span>
        {second ? (
          <span className="block truncate text-meta text-muted-foreground">{second}</span>
        ) : null}
      </span>
    </>
  );
}

/** Can use / Can edit / Full access, with what each adds. */
function LevelSelect({
  value,
  onChange,
  label,
}: {
  value: AgentAccess;
  onChange: (access: AgentAccess) => void;
  label: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as AgentAccess)}>
      <SelectTrigger aria-label={label} className="h-8 w-[132px] shrink-0 text-sm">
        {/* The name alone in the trigger; the item below carries a hint too,
            which Radix would otherwise copy up here. */}
        <SelectValue>{ACCESS_LABEL[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="w-64">
        {AGENT_ACCESS.map((level) => (
          <SelectItem key={level} value={level} textValue={ACCESS_LABEL[level]}>
            <span className="flex flex-col">
              <span>{ACCESS_LABEL[level]}</span>
              <span className="text-meta text-muted-foreground">{ACCESS_HINT[level]}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

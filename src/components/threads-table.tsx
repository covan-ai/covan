import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MoreHorizontal, Search } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, type ThreadRow, type ThreadsFilter } from "@/lib/api-client";
import { useAgentsStore } from "@/lib/agents-store";
import { DataTable, Pagination, type Column } from "@/components/data-table";
import { Pills } from "@/components/pills";
import { Chip } from "@/components/chip";
import { Avatar } from "@/components/avatar";
import { AgentMark } from "@/components/agent-mark";
import { StatusWord } from "@/components/status-dot";
import { EmptyPage } from "@/components/empty-page";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { lastActivityLabel } from "@/lib/day-groups";
import { shortName } from "@/lib/monogram";

const PAGE_SIZE = 25;

/**
 * Every thread the caller can see, as a table (A5): searchable, filtered by
 * pills and an agent, paged. On an agent's Threads tab it is that agent's,
 * and the agent column and select go.
 */
export function ThreadsTable({ agentId }: { agentId?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { agents } = useAgentsStore();
  const [filter, setFilter] = useState<ThreadsFilter>("all");
  const [agent, setAgent] = useState<string | undefined>(agentId);
  const [sort, setSort] = useState<"activity" | "created" | "title">("activity");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [renaming, setRenaming] = useState<ThreadRow | null>(null);

  const query = useQuery({
    queryKey: ["sessions", "table", { filter, agent, sort, q, page }],
    queryFn: () =>
      api.sessions.table({
        filter,
        agentId: agent,
        sort,
        q: q.trim() || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
  };

  const share = useMutation({
    mutationFn: (row: ThreadRow) =>
      api.sessions.setVisibility(row.id, row.visibility === "shared" ? "private" : "shared"),
    onSuccess: refresh,
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't change who can see it."),
  });
  const remove = useMutation({
    mutationFn: (row: ThreadRow) => api.sessions.remove(row.id),
    onSuccess: () => {
      toast.success("Thread deleted. It can be restored for 30 days.");
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete that thread."),
  });

  const open = (row: ThreadRow) =>
    void navigate({
      to: "/agents/$agentId/chat",
      params: { agentId: row.agentId },
      search: { s: row.id },
    });

  const columns: Column<ThreadRow>[] = [
    {
      key: "thread",
      header: "Thread",
      className: "w-full max-w-0",
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{r.title ?? "Untitled thread"}</span>
          {r.visibility === "shared" && !r.isMine && <Chip>Shared</Chip>}
        </span>
      ),
    },
    ...(agentId
      ? []
      : [
          {
            key: "agent",
            header: "Agent",
            hideBelow: "md" as const,
            cell: (r: ThreadRow) => <Chip>{byId.get(r.agentId)?.name ?? "Agent"}</Chip>,
          },
        ]),
    {
      key: "owner",
      header: "Owner",
      hideBelow: "lg",
      cell: (r) =>
        r.routine ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <AgentMark agent={byId.get(r.agentId) ?? { name: "Routine" }} size={20} />
            Routine
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Avatar name={r.ownerName} url={r.ownerAvatarUrl} size={20} />
            {r.isMine ? "You" : shortName(r.ownerName)}
          </span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) =>
        r.state === "needs_you" ? (
          <StatusWord state="waiting" />
        ) : r.state === "running" ? (
          <StatusWord state="running">
            {r.runningStep ? `Running · step ${r.runningStep}` : "Running"}
          </StatusWord>
        ) : (
          <StatusWord state="done" />
        ),
    },
    {
      key: "activity",
      header: "Last activity",
      hideBelow: "md",
      cell: (r) => (
        <span className="text-muted-foreground">{lastActivityLabel(r.lastActivityAt)}</span>
      ),
    },
    ...(data?.unit
      ? [
          {
            key: "cost",
            header: data.unit === "credits" ? "Credits" : "Cost",
            num: true,
            hideBelow: "lg" as const,
            cell: (r: ThreadRow) =>
              data.unit === "credits" ? r.cost.toLocaleString("en-US") : `$${r.cost.toFixed(2)}`,
          },
        ]
      : []),
    {
      key: "more",
      header: <span className="sr-only">Actions</span>,
      className: "w-10",
      cell: (r) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`More for ${r.title ?? "this thread"}`}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={() => open(r)}>Open</DropdownMenuItem>
            {r.isMine && (
              <>
                <DropdownMenuItem onClick={() => setRenaming(r)}>Rename</DropdownMenuItem>
                <DropdownMenuItem onClick={() => share.mutate(r)}>
                  {r.visibility === "shared" ? "Make private" : "Share with workspace"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onClick={() => remove.mutate(r)}>
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-card px-2.5 sm:w-[280px]">
          <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <input
            aria-label="Search threads"
            placeholder="Search threads"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-micro-foreground"
          />
        </label>
        <Pills
          label="Show"
          value={filter}
          onChange={(f) => {
            setFilter(f);
            setPage(1);
          }}
          options={[
            { value: "all", label: "All" },
            { value: "mine", label: "Mine" },
            { value: "shared", label: "Shared with me" },
            { value: "waiting", label: "Waiting" },
            { value: "running", label: "Running" },
          ]}
        />
        <span className="flex-1" />
        {!agentId && agents.length > 1 && (
          <Select
            value={agent ?? "all"}
            onValueChange={(v) => {
              setAgent(v === "all" ? undefined : v);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="Agent" className="w-auto min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">All agents</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
          <SelectTrigger aria-label="Sort" className="w-auto min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="activity">Last activity</SelectItem>
            <SelectItem value="created">Newest</SelectItem>
            <SelectItem value="title">Title</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4">
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <DataTable
            label="Threads"
            columns={columns}
            rows={data?.rows ?? []}
            rowKey={(r) => r.id}
            onRowClick={open}
            empty={
              <EmptyPage
                title={q || filter !== "all" ? "No threads match" : "No threads yet"}
                description={
                  q || filter !== "all"
                    ? "Try another word, or show every thread."
                    : "A thread starts when somebody asks an agent something."
                }
              />
            }
          />
        )}
      </div>
      {data && data.total > 0 && (
        <Pagination
          shown={data.rows.length}
          total={data.total}
          page={page}
          pageCount={pageCount}
          onPage={setPage}
        />
      )}

      <TextPromptDialog
        open={renaming !== null}
        onOpenChange={(v) => !v && setRenaming(null)}
        title="Rename thread"
        label="Name"
        initialValue={renaming?.title ?? ""}
        submitLabel="Rename"
        busyLabel="Renaming…"
        onSubmit={async (title) => {
          if (!renaming) return false;
          try {
            await api.sessions.rename(renaming.id, title);
            refresh();
            return true;
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : "Couldn't rename it.");
            return false;
          }
        }}
      />
    </>
  );
}

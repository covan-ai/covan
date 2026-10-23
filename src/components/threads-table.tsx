import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MoreHorizontal, Search } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
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
import { dotWord } from "@/lib/dot-states";
import { shortName } from "@/lib/monogram";

const PAGE_SIZE = 25;

/**
 * Every thread the caller can see, as a table (A5): searchable, filtered by
 * pills and an agent, paged. On an agent's Threads tab it is that agent's,
 * and the agent column and select go.
 */
export function ThreadsTable({ agentId }: { agentId?: string }) {
  const { t } = useTranslation();
  const locale = useLocale();
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
      toast.error(e instanceof ApiError ? e.message : t("Couldn't change who can see it.")),
  });
  const remove = useMutation({
    mutationFn: (row: ThreadRow) => api.sessions.remove(row.id),
    onSuccess: () => {
      toast.success(t("Thread deleted. It can be restored for 30 days."));
      refresh();
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : t("Couldn't delete that thread.")),
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
      header: t("Thread"),
      className: "w-full max-w-0",
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{r.title ?? t("Untitled thread")}</span>
          {r.visibility === "shared" && !r.isMine && <Chip>{t("Shared")}</Chip>}
        </span>
      ),
    },
    ...(agentId
      ? []
      : [
          {
            key: "agent",
            header: t("Agent"),
            hideBelow: "md" as const,
            cell: (r: ThreadRow) => <Chip>{byId.get(r.agentId)?.name ?? t("Agent")}</Chip>,
          },
        ]),
    {
      key: "owner",
      header: t("Owner"),
      hideBelow: "lg",
      cell: (r) =>
        r.routine ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <AgentMark agent={byId.get(r.agentId) ?? { name: t("Routine") }} size={20} />
            {t("Routine")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Avatar name={r.ownerName} url={r.ownerAvatarUrl} size={20} />
            {r.isMine ? t("You") : shortName(r.ownerName)}
          </span>
        ),
    },
    {
      key: "status",
      header: t("Status"),
      cell: (r) =>
        r.state === "needs_you" ? (
          <StatusWord state="waiting">{dotWord("waiting", t)}</StatusWord>
        ) : r.state === "running" ? (
          <StatusWord state="running">
            {r.runningStep
              ? t("Running · step {{step}}", { step: r.runningStep })
              : dotWord("running", t)}
          </StatusWord>
        ) : (
          <StatusWord state="done">{dotWord("done", t)}</StatusWord>
        ),
    },
    {
      key: "activity",
      header: t("Last activity"),
      hideBelow: "md",
      cell: (r) => (
        <span className="text-muted-foreground">
          {lastActivityLabel(r.lastActivityAt, Date.now(), t, locale)}
        </span>
      ),
    },
    ...(data?.unit
      ? [
          {
            key: "cost",
            header: data.unit === "credits" ? t("Credits") : t("Cost"),
            num: true,
            hideBelow: "lg" as const,
            cell: (r: ThreadRow) =>
              data.unit === "credits"
                ? r.cost.toLocaleString(locale)
                : new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
                    r.cost,
                  ),
          },
        ]
      : []),
    {
      key: "more",
      header: <span className="sr-only">{t("Actions")}</span>,
      className: "w-10",
      cell: (r) => {
        const untitled = t("this thread");
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("More for {{title}}", { title: r.title ?? untitled })}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={() => open(r)}>{t("Open")}</DropdownMenuItem>
              {r.isMine && (
                <>
                  <DropdownMenuItem onClick={() => setRenaming(r)}>{t("Rename")}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => share.mutate(r)}>
                    {r.visibility === "shared" ? t("Make private") : t("Share with workspace")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onClick={() => remove.mutate(r)}>
                    {t("Delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-card px-2.5 sm:w-[280px]">
          <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <input
            aria-label={t("Search threads")}
            placeholder={t("Search threads")}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-micro-foreground"
          />
        </label>
        <Pills
          label={t("Show")}
          value={filter}
          onChange={(f) => {
            setFilter(f);
            setPage(1);
          }}
          options={[
            { value: "all", label: t("All") },
            { value: "mine", label: t("Mine") },
            { value: "shared", label: t("Shared with me") },
            { value: "waiting", label: t("Waiting") },
            { value: "running", label: t("Running") },
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
            <SelectTrigger aria-label={t("Agent")} className="w-auto min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">{t("All agents")}</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
          <SelectTrigger aria-label={t("Sort")} className="w-auto min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="activity">{t("Last activity")}</SelectItem>
            <SelectItem value="created">{t("Newest")}</SelectItem>
            <SelectItem value="title">{t("Title")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4">
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
        ) : (
          <DataTable
            label={t("Threads")}
            columns={columns}
            rows={data?.rows ?? []}
            rowKey={(r) => r.id}
            onRowClick={open}
            empty={
              <EmptyPage
                title={q || filter !== "all" ? t("No threads match") : t("No threads yet")}
                description={
                  q || filter !== "all"
                    ? t("Try another word, or show every thread.")
                    : t("A thread starts when somebody asks an agent something.")
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
        title={t("Rename thread")}
        label={t("Name")}
        initialValue={renaming?.title ?? ""}
        submitLabel={t("Rename")}
        busyLabel={t("Renaming…")}
        onSubmit={async (title) => {
          if (!renaming) return false;
          try {
            await api.sessions.rename(renaming.id, title);
            refresh();
            return true;
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : t("Couldn't rename it."));
            return false;
          }
        }}
      />
    </>
  );
}

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import { api } from "@/lib/api-client";
import type { Idea, IdeaStage } from "@/lib/agents-store";
import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

const STAGES: { key: IdeaStage; label: string }[] = [
  { key: "review", label: "To review" },
  { key: "promising", label: "Promising" },
  { key: "in_progress", label: "In progress" },
  { key: "parked", label: "Parked" },
];

export function IdeaBoard({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const key = ["ideas", sessionId] as const;

  const { data: ideas = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.ideas.list(sessionId),
  });

  // Live-sync the board: any INSERT/UPDATE/DELETE on this session's ideas
  // refetches so every participant stays in sync.
  useEffect(() => {
    const channel = supabase
      .channel(`ideas:${sessionId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ideas", filter: `session_id=eq.${sessionId}` },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["ideas", sessionId] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId, queryClient]);

  const moveMutation = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: IdeaStage }) =>
      api.ideas.update(id, { stage }),
    onMutate: async ({ id, stage }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<Idea[]>(key);
      queryClient.setQueryData<Idea[]>(key, (old = []) =>
        old.map((i) => (i.id === id ? { ...i, stage } : i)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(key, ctx.prev);
      toast.error("Could not move the card.");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.ideas.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
    onError: () => toast.error("Could not delete the card."),
  });

  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const overStage = e.over?.id as IdeaStage | undefined;
    if (!overStage) return;
    const idea = ideas.find((i) => i.id === id);
    if (!idea || idea.stage === overStage) return;
    moveMutation.mutate({ id, stage: overStage });
  };

  return (
    <DndContext onDragEnd={onDragEnd}>
      <div className="grid h-full grid-cols-1 gap-3 overflow-y-auto p-3 sm:grid-cols-2 xl:grid-cols-4">
        {STAGES.map((s) => (
          <Column
            key={s.key}
            stage={s.key}
            label={s.label}
            ideas={ideas.filter((i) => i.stage === s.key)}
            onRemove={(id) => removeMutation.mutate(id)}
          />
        ))}
      </div>
    </DndContext>
  );
}

function Column({
  stage,
  label,
  ideas,
  onRemove,
}: {
  stage: IdeaStage;
  label: string;
  ideas: Idea[];
  onRemove: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-24 flex-col rounded-xl border border-border bg-muted/30 p-2",
        isOver && "ring-2 ring-primary/40",
      )}
    >
      <div className="px-1 pb-2 text-xs font-semibold text-muted-foreground">
        {label} <span className="ml-1 text-muted-foreground/60">{ideas.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {ideas.map((i) => (
          <IdeaCard key={i.id} idea={i} onRemove={onRemove} />
        ))}
      </div>
    </div>
  );
}

function IdeaCard({ idea, onRemove }: { idea: Idea; onRemove: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: idea.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cn(
        "group rounded-lg border border-border bg-card p-2.5 shadow-sm",
        isDragging && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab text-left text-sm font-medium text-foreground active:cursor-grabbing"
        >
          {idea.title}
        </button>
        <button
          onClick={() => onRemove(idea.id)}
          aria-label="Delete card"
          className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {idea.detail && <p className="mt-1 text-xs text-muted-foreground">{idea.detail}</p>}
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api-client";
import { deleteSummarySentence } from "@/lib/agent-access";

/**
 * "Delete Support?" (A25): what a delete takes with it, counted before
 * anybody presses — threads that stay readable for 30 days, routines that
 * stop, folders that are not touched — then Cancel or the red word.
 */
export function DeleteAgentDialog({
  agent,
  open,
  onOpenChange,
  onDelete,
}: {
  agent: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
}) {
  const { data, isError } = useQuery({
    queryKey: ["agent-delete-summary", agent.id],
    queryFn: () => api.agents.deleteSummary(agent.id),
    enabled: open,
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {data
              ? deleteSummarySentence(data)
              : isError
                ? "Its threads stay readable for 30 days under Recently deleted, then go. Routines pointed at it stop now. The folders it reads are not touched."
                : "Counting what it takes with it…"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="danger" onClick={onDelete}>
            Delete {agent.name}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

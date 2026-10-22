import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { goKeyReader, isTyping } from "@/lib/go-keys";
import { useAgentsStore } from "@/lib/agents-store";

/**
 * The palette's shortcuts, live wherever the shell is: G then a letter goes
 * to a page; N starts a thread with the agent you are in, and outside one
 * opens the palette, whose first rows are the agents.
 */
export function useGoKeys(agentId: string | undefined) {
  const navigate = useNavigate();
  const { startSession, canWrite } = useAgentsStore();
  useEffect(() => {
    const read = goKeyReader();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const go = read(e.key);
      if (!go) return;
      e.preventDefault();
      if (go !== "new-thread") {
        void navigate({ to: go });
        return;
      }
      if (!agentId || !canWrite) {
        window.dispatchEvent(new Event("open-command-palette"));
        return;
      }
      void startSession(agentId)
        .then((s) =>
          navigate({ to: "/agents/$agentId/chat", params: { agentId }, search: { s: s.id } }),
        )
        .catch(() => toast.error("Couldn't start a new thread."));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [agentId, canWrite, navigate, startSession]);
}

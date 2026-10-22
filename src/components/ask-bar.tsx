import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowUp, ChevronDown, Plus, X } from "lucide-react";
import { AgentMark } from "@/components/agent-mark";
import { Chip } from "@/components/chip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentsStore, type Agent } from "@/lib/agents-store";
import { ACCEPT } from "@/lib/uploads";
import { useChatUploads } from "@/lib/use-chat-uploads";

/**
 * Home's one line for asking (Main): the agent, what to ask it, a file, send.
 *
 * Sending starts a thread, leaves the words under `chat-draft:<id>` and opens
 * it; the thread sends them once it lands empty. A file goes into the agent's
 * chat folder straight away, exactly as it would from inside the thread, so
 * the agent can read it by the time the question arrives — which is also why
 * the agent cannot be changed once a file is on its way to this one.
 */
export function AskBar({
  agents,
  selected,
  onSelect,
}: {
  agents: Agent[];
  selected: Agent;
  onSelect: (id: string) => void;
}) {
  const { startSession } = useAgentsStore();
  const navigate = useNavigate();
  const uploads = useChatUploads(selected);
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const uploading = uploads.receipts.some((r) => r.state === "uploading");
  const attached = uploads.receipts.some((r) => r.state === "done");
  const canSend = !sending && !uploading && (text.trim() !== "" || attached);
  const locked = uploads.receipts.length > 0;

  const launch = async () => {
    if (!canSend) return;
    const body = text.trim();
    setSending(true);
    try {
      const session = await startSession(selected.id);
      if (body) {
        try {
          sessionStorage.setItem(`chat-draft:${session.id}`, body);
        } catch {
          /* private mode or storage full: the thread opens empty */
        }
      }
      void navigate({
        to: "/agents/$agentId/chat",
        params: { agentId: selected.id },
        search: { s: session.id },
      });
    } catch {
      toast.error("Couldn't start the thread.");
      setSending(false);
    }
  };

  return (
    <div>
      <label htmlFor="home-ask" className="sr-only">
        Ask an agent
      </label>
      <div className="flex h-12 items-center gap-2 rounded-lg border border-input bg-background px-2 shadow-xs transition-colors focus-within:border-muted-foreground">
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={locked || agents.length < 2}>
            <Button
              variant="ghost"
              className="h-8 shrink-0 gap-2 pr-2 pl-1.5 text-foreground disabled:opacity-100"
              aria-label={`Ask ${selected.name}. Change agent`}
            >
              <AgentMark agent={selected} size={24} />
              <span className="max-w-[10rem] truncate">{selected.name}</span>
              {agents.length > 1 && !locked && <ChevronDown className="text-muted-foreground" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel className="text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
              Ask
            </DropdownMenuLabel>
            <div className="max-h-72 overflow-y-auto">
              {agents.map((a) => (
                <DropdownMenuItem key={a.id} onClick={() => onSelect(a.id)}>
                  <AgentMark agent={a} size={24} />
                  <span className="flex-1 truncate">{a.name}</span>
                </DropdownMenuItem>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <span aria-hidden className="h-5 w-px shrink-0 bg-border" />
        <input
          id="home-ask"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void launch();
            }
          }}
          placeholder={`Ask ${selected.name}…`}
          autoComplete="off"
          className="h-8 min-w-0 flex-1 border-0 bg-transparent text-lead outline-none placeholder:text-muted-foreground"
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Attach a file"
          className="text-muted-foreground"
          onClick={() => fileRef.current?.click()}
        >
          <Plus />
        </Button>
        <Button size="icon" aria-label="Send" disabled={!canSend} onClick={() => void launch()}>
          <ArrowUp />
        </Button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          aria-label="Choose files to attach"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length > 0) void uploads.addFiles(files);
          }}
        />
      </div>
      {uploads.receipts.length > 0 && (
        <ul aria-label="Attached files" className="mt-2 flex flex-wrap gap-1.5">
          {uploads.receipts.map((r) => (
            <li key={r.id}>
              <Chip className="pr-1">
                <span className="max-w-[16rem] truncate">{r.name}</span>
                <span className="text-muted-foreground">
                  {r.state === "uploading"
                    ? `${Math.round(r.progress)}%`
                    : r.state === "failed"
                      ? "failed"
                      : "added"}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${r.name}`}
                  onClick={() =>
                    r.state === "done" ? void uploads.remove(r.id) : uploads.dismiss(r.id)
                  }
                  className="grid size-4 place-items-center rounded-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </Chip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

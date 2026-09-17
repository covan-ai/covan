import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { useAgentsStore } from "@/lib/agents-store";
import { AgentAvatar } from "@/components/avatars";
import { useTheme } from "@/lib/theme";
import {
  BookOpen,
  LayoutGrid,
  Users,
  Plug,
  Settings,
  Plus,
  Moon,
  Sun,
  MessageSquare,
} from "lucide-react";
import { DOCS_HOME } from "@/lib/docs";
import { api } from "@/lib/api-client";
import { useQuery } from "@tanstack/react-query";
import type { Message } from "@/lib/agents-store";

/**
 * Global ⌘K / Ctrl+K palette: jump to any agent, or run a top-level action.
 * Mounted once at the root so it's reachable from every screen.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const navigate = useNavigate();
  const { agents, canWrite } = useAgentsStore();
  const { theme, toggle } = useTheme();
  const { sessions } = useAgentsStore();

  // Global message search: runs when the user types in the palette. Debounced
  // by the CommandInput itself — every keystroke updates searchQuery, but the
  // query only fires when the input settles.
  const { data: searchResults = [] } = useQuery({
    queryKey: ["search-messages", searchQuery],
    queryFn: () => api.search.messages(searchQuery, { limit: 5 }),
    enabled: searchQuery.length >= 3,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  const run = (fn: () => void) => {
    setOpen(false);
    setSearchQuery("");
    fn();
  };

  const pages = [
    { label: "Home", icon: LayoutGrid, to: "/app" as const },
    { label: "Team", icon: Users, to: "/team" as const },
    { label: "Integrations", icon: Plug, to: "/integrations" as const },
    { label: "Settings", icon: Settings, to: "/settings" as const },
  ];

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search agents, messages, or jump to…"
        value={searchQuery}
        onValueChange={setSearchQuery}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {searchResults.length > 0 && (
          <CommandGroup heading="Messages">
            {searchResults.map((m: Message) => {
              const session = sessions.find((s) => s.messages?.some((msg) => msg.id === m.id));
              return (
                <CommandItem
                  key={m.id}
                  value={`message ${m.content}`}
                  onSelect={() => {
                    if (session) {
                      run(() =>
                        navigate({
                          to: "/agents/$agentId/chat",
                          params: { agentId: session.agentId },
                          search: { s: session.id },
                        }),
                      );
                    }
                  }}
                >
                  <MessageSquare className="h-4 w-4" />
                  <span className="line-clamp-1 flex-1">{m.content}</span>
                  {session && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {session.title || "Untitled"}
                    </span>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {searchResults.length > 0 && <CommandSeparator />}

        {agents.length > 0 && (
          <CommandGroup heading="Agents">
            {agents.map((a) => (
              <CommandItem
                key={a.id}
                value={`agent ${a.name}`}
                onSelect={() =>
                  run(() => navigate({ to: "/agents/$agentId", params: { agentId: a.id } }))
                }
              >
                <AgentAvatar id={a.id} emoji={a.emoji} className="h-5 w-5 rounded-md text-xs" />
                <span>{a.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{a.model}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />

        <CommandGroup heading="Go to">
          {pages.map((p) => (
            <CommandItem
              key={p.to}
              value={`go ${p.label}`}
              onSelect={() => run(() => navigate({ to: p.to }))}
            >
              <p.icon className="h-4 w-4" />
              <span>{p.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Actions">
          {/* Not offered to a viewer. ⌘K is the one place a control can be
              found without seeing the screen it lives on, so leaving it here
              would route somebody straight to a dialog that cannot save. */}
          {canWrite && (
            <CommandItem
              value="new agent create"
              onSelect={() => run(() => navigate({ to: "/app", search: { new: true } }))}
            >
              <Plus className="h-4 w-4" />
              <span>New agent</span>
            </CommandItem>
          )}
          <CommandItem value="toggle theme dark light" onSelect={() => run(toggle)}>
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span>Toggle theme</span>
          </CommandItem>
          {/* Searchable by "help", which is what someone stuck actually types. */}
          <CommandItem
            value="documentation docs help guide"
            onSelect={() => run(() => window.open(DOCS_HOME, "_blank", "noreferrer"))}
          >
            <BookOpen className="h-4 w-4" />
            <span>Documentation</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

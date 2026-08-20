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
import { LayoutGrid, Users, Plug, Settings, Plus, Moon, Sun } from "lucide-react";

/**
 * Global ⌘K / Ctrl+K palette: jump to any agent, or run a top-level action.
 * Mounted once at the root so it's reachable from every screen.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { agents } = useAgentsStore();
  const { theme, toggle } = useTheme();

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
      <CommandInput placeholder="Search agents or jump to…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

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
          <CommandItem
            value="new agent create"
            onSelect={() => run(() => navigate({ to: "/app", search: { new: true } }))}
          >
            <Plus className="h-4 w-4" />
            <span>New agent</span>
          </CommandItem>
          <CommandItem value="toggle theme dark light" onSelect={() => run(toggle)}>
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span>Toggle theme</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

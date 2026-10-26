import { useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Sidebar } from "@/components/sidebar/sidebar";
import { ShellProvider } from "@/components/shell-provider";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { BannerStack } from "@/components/banner-stack";
import { CommandPalette } from "@/components/command-palette";
import { useGoKeys } from "@/hooks/use-go-keys";
import type { CreateAgentInitial, ShellApi } from "@/lib/shell";
import { cn } from "@/lib/utils";

/**
 * The frame around every signed-in page (DESIGN.md §6), rendered once by
 * `routes/_authed.tsx`: the 248px sidebar and the page. Below `lg` the
 * sidebar is a drawer behind the page's own bar, which opens it.
 *
 * It owns the one "Create agent" dialog, so the sidebar's "+", Home and the
 * palette all open the same thing.
 */
export function AppShell({ agentId, children }: { agentId?: string; children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // What the next "New agent" opens filled with, from a use case. Cleared on
  // close, so the sidebar's "+" afterwards opens an empty one.
  const [createInitial, setCreateInitial] = useState<CreateAgentInitial | undefined>();
  useGoKeys(agentId);

  // A page change closes the drawer, however it happened: noticed while
  // rendering, the way React asks for state that follows a prop.
  const [drawerPath, setDrawerPath] = useState(pathname);
  if (drawerPath !== pathname) {
    setDrawerPath(pathname);
    setDrawerOpen(false);
  }
  useEffect(() => {
    const open = () => {
      setCreateInitial(undefined);
      setCreateOpen(true);
    };
    window.addEventListener("open-create-agent", open);
    return () => window.removeEventListener("open-create-agent", open);
  }, []);

  const api = useMemo<ShellApi>(
    () => ({
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
      openCreateAgent: (initial?: CreateAgentInitial) => {
        setCreateInitial(initial);
        setCreateOpen(true);
      },
    }),
    [drawerOpen],
  );
  const close = () => setDrawerOpen(false);

  return (
    <ShellProvider value={api}>
      <div className="flex min-h-dvh w-full bg-background text-foreground">
        <div className="sticky top-0 hidden h-dvh lg:block">
          <Sidebar agentId={agentId} />
        </div>
        {/* The phone's drawer and the scrim behind it. */}
        <div
          className={cn(
            "fixed inset-0 z-40 bg-black/30 transition-opacity lg:hidden",
            drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={close}
          aria-hidden
        />
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-50 transition-transform lg:hidden",
            drawerOpen ? "translate-x-0" : "-translate-x-full",
          )}
          inert={!drawerOpen}
        >
          <Sidebar agentId={agentId} onNavigate={close} />
        </div>
        {/* A page that is a window rather than a document — a thread, with its
            composer pinned to the bottom — marks itself `data-fill-screen`,
            and the column holds to the screen's height for it. */}
        <main className="flex min-w-0 flex-1 flex-col has-[[data-fill-screen]]:h-dvh">
          <BannerStack />
          {children}
        </main>
      </div>
      <CreateAgentDialog
        open={createOpen}
        initial={createInitial}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setCreateInitial(undefined);
        }}
      />
      <CommandPalette agentId={agentId} />
    </ShellProvider>
  );
}

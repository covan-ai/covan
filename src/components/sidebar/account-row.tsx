import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronsUpDown, LogOut, Monitor, Moon, Sun, User } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { useTheme } from "@/lib/theme";
import { DOCS_HOME } from "@/lib/docs";
import { Avatar } from "@/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { NAV_ROW } from "./nav-rows";

/** You, at the very foot of the sidebar: your profile, the theme, the documentation, the way out. */
export function AccountRow({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { preference, mounted, setPreference } = useTheme();
  const themes = [
    { key: "light", label: "Light", icon: Sun },
    { key: "dark", label: "Dark", icon: Moon },
    { key: "system", label: "System", icon: Monitor },
  ] as const;

  const signOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out");
    void navigate({ to: "/sign-in" });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Account" className={cn(NAV_ROW, "text-left")}>
          <Avatar name={me?.user.name} url={me?.user.avatarUrl} size={24} />
          <span className="min-w-0 flex-1 truncate">{me?.user.name ?? "…"}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-micro-foreground" strokeWidth={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{me?.user.name ?? "…"}</div>
          <div className="truncate text-meta text-muted-foreground">{me?.user.email ?? "…"}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/profile" onClick={onNavigate}>
            <User /> Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuLabel className="pt-2 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
          Theme
        </DropdownMenuLabel>
        {/* Three buttons rather than items, so picking one leaves the menu
            open and the change can be seen without reopening it. */}
        <div role="radiogroup" aria-label="Theme" className="flex gap-1 px-1.5 pb-1.5">
          {themes.map((t) => {
            const on = mounted && preference === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPreference(t.key)}
                className={cn(
                  "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium",
                  on
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-surface",
                )}
              >
                <t.icon className="size-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={DOCS_HOME} target="_blank" rel="noreferrer">
            <BookOpen /> Documentation
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void signOut()} className="text-destructive">
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "@/lib/api-client";
import { SettingsNav, SettingsTabs } from "@/components/settings/settings-nav";
import { privacyLink, termsLink } from "@/lib/legal";
import { LegalAnchor } from "@/components/legal-anchor";

/**
 * Settings was one long page that mixed what belongs to you (your name, your
 * keys, closing your account) with what belongs to the workspace (its name,
 * its default model, its trash). It is an area now: this route is the frame,
 * and each page under it is about one of the two.
 *
 * The frame is a card over the app rather than a page in it. Settings are a
 * detour, not a destination — you open them, change one thing, and go back to
 * what you were doing — and a card that closes says that where a page that
 * replaces the screen does not. Escape and "Back to app" both close it.
 *
 * `/settings` itself has no page; `_authed.settings.index.tsx` sends it to
 * your account, which is where both entries in the sidebar's account menu used
 * to land.
 */
export const Route = createFileRoute("/_authed/settings")({
  component: SettingsLayout,
  head: () => ({
    meta: [
      { title: "Settings — Covan" },
      { name: "description", content: "Your account and your workspace's settings in Covan." },
    ],
  }),
});

function SettingsLayout() {
  const navigate = useNavigate();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only when nothing else is listening: a dialog over the card, or a
      // menu, takes its own Escape first and the event never reaches here.
      if (e.key === "Escape" && !e.defaultPrevented) navigate({ to: "/app" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/40 lg:p-8"
        onClick={(e) => {
          if (e.target === e.currentTarget) navigate({ to: "/app" });
        }}
      >
        <div
          role="dialog"
          aria-label="Settings"
          className="mx-auto flex h-full w-full max-w-[1180px] overflow-hidden bg-background shadow-card lg:rounded-2xl lg:border lg:border-border"
        >
          <div className="hidden w-60 shrink-0 overflow-y-auto border-r border-border bg-sidebar p-3 lg:block">
            <SettingsNav workspaceName={me?.workspace.name} />
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {/* The phone's version of the column: a row of tabs and a close. */}
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 lg:hidden">
              <div className="min-w-0 flex-1">
                <SettingsTabs />
              </div>
              <button
                onClick={() => navigate({ to: "/app" })}
                aria-label="Back to app"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8 lg:px-10">
              <Outlet />

              {/* Both documents were reachable from exactly one place — the "I
                  agree" checkbox on the sign-up form — so the moment somebody
                  had an account they had no way back to what they had agreed
                  to. Settings is where a reader looks. New tab: nobody should
                  lose a workspace to read a policy. In the frame rather than on
                  one page, so every settings page has it. */}
              <p className="mt-16 border-t border-hairline pt-6 text-xs text-muted-foreground">
                <LegalAnchor link={termsLink()} newTab>
                  Terms
                </LegalAnchor>{" "}
                ·{" "}
                <LegalAnchor link={privacyLink()} newTab>
                  Privacy Policy
                </LegalAnchor>
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api-client";
import { OPEN_THE_EMAIL, useAcceptInvitation } from "@/lib/accept-invitation";
import { useCredits } from "@/lib/credits";
import { dismiss, isDismissed } from "@/lib/dismissed";
import { Banner } from "@/components/banner";
import { StatusDot } from "@/components/status-dot";
import { Tile } from "@/components/tile";
import { Button } from "@/components/ui/button";

const noop = () => () => {};

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

/**
 * The banners over the page (A31, A33), most urgent first and never more
 * than two: offline, an invitation to another workspace, a low balance.
 */
export function BannerStack() {
  const queryClient = useQueryClient();
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: incoming = [] } = useQuery({
    queryKey: ["invitations", "incoming"],
    queryFn: () => api.invitations.incoming(),
  });
  const { accept, canAccept, busy } = useAcceptInvitation();
  const credits = useCredits();
  // Re-read what was dismissed after a dismissal. Session storage is the
  // browser's, so nothing dismissed is known until the page is hydrated.
  const [, setTick] = useState(0);
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const put = (id: string) => {
    dismiss(id);
    setTick((n) => n + 1);
  };

  const banners = [];
  if (!online) {
    banners.push(
      <Banner
        key="offline"
        kind="notice"
        label="Offline"
        leading={<StatusDot state="waiting" />}
        actions={
          <button
            type="button"
            className="font-medium hover:underline"
            onClick={() => void queryClient.refetchQueries()}
          >
            Retry
          </button>
        }
      >
        <span className="font-medium">You are offline.</span>{" "}
        <span className="text-muted-foreground">
          What you type is kept and sent when you are back. Running agents keep running.
        </span>
      </Banner>,
    );
  }
  const invitation = mounted ? incoming.find((i) => !isDismissed(`invite:${i.id}`)) : undefined;
  if (invitation) {
    const role = invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1);
    banners.push(
      <Banner
        key="invitation"
        kind="invitation"
        label="Invitation"
        leading={<Tile label={invitation.workspaceName} tone="ink" letters={1} />}
        actions={
          <>
            {canAccept(invitation.id) ? (
              <Button size="sm" disabled={busy} onClick={() => void accept(invitation.id)}>
                Accept
              </Button>
            ) : (
              <span className="text-meta text-muted-foreground max-md:hidden">
                {OPEN_THE_EMAIL}
              </span>
            )}
            <Button size="sm" variant="ghost" onClick={() => put(`invite:${invitation.id}`)}>
              Ignore
            </Button>
          </>
        }
      >
        <span className="font-medium">
          {invitation.inviterName ?? "Somebody"} invited you to {invitation.workspaceName}
        </span>{" "}
        <span className="text-muted-foreground">
          as a {role}.{me ? ` Your ${me.workspace.name} workspace is not affected.` : ""}
        </span>
      </Banner>,
    );
  }
  const creditsKey = "credits-low";
  if (credits && credits.level !== "fine" && mounted && !isDismissed(creditsKey)) {
    banners.push(
      <Banner
        key="credits"
        kind="notice"
        label="Credits"
        leading={<StatusDot state="waiting" />}
        actions={
          <Link to="/settings/usage" className="font-medium hover:underline">
            Buy credits
          </Link>
        }
        onDismiss={() => put(creditsKey)}
      >
        <span className="font-medium">
          {credits.level === "spent"
            ? "Out of credits."
            : `${credits.balance.toLocaleString("en-US")} credits left.`}
        </span>{" "}
        <span className="text-muted-foreground">
          {credits.level === "spent"
            ? "Agents pause until credits arrive; nothing is lost."
            : "Agents pause at zero; nothing is lost."}
        </span>
      </Banner>,
    );
  }
  return <>{banners.slice(0, 2)}</>;
}

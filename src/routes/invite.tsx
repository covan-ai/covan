import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { Trans, lookup, msg, useTranslation } from "@/i18n";
import { AuthLayout } from "@/components/auth-layout";
import { Avatar } from "@/components/avatar";
import { Tile } from "@/components/tile";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase/client";
import {
  forgetInviteLink,
  inviteFromFragment,
  inviteLinkFromFragment,
  stashInvite,
  stashInviteLink,
  stashedInviteLink,
} from "@/lib/invite-stash";
import { api, ApiError, type InvitationPreview, type InviteLinkPreview } from "@/lib/api-client";

export const Route = createFileRoute("/invite")({
  component: Invite,
});

/** What each role may do, in the invitation's own words (A23). */
const ROLE_SENTENCE: Record<string, string> = {
  admin: msg("you can use and manage every agent, the people and the billing."),
  member: msg(
    "you can use every shared agent and start your own threads. Threads you start are private to you.",
  ),
  viewer: msg("you can read what is shared with you."),
};

/** The role as a word on the card; an unknown one is shown as the API spelt it. */
const ROLE_WORD: Record<string, string> = {
  admin: msg("Admin"),
  member: msg("Member"),
  viewer: msg("Viewer"),
};

/** Whole days until the invitation lapses: 1 is tomorrow; null once it has passed. */
function daysLeft(at: number | null | undefined, now: number): number | null {
  if (!at) return null;
  const days = Math.ceil((at - now) / 86_400_000);
  return days <= 0 ? null : days;
}

type Preview = (InvitationPreview | InviteLinkPreview) & { kind: "email" | "link" };

/**
 * Where an invitation's link lands (A23).
 *
 * Two kinds arrive here. An email invitation (`#id=…&token=…`) is for one
 * address: signed out, the card says whose workspace and as what, and offers
 * the way in; signed in, the invitation is waiting inside, so this forwards.
 * A workspace's shareable link (`#link=…`, 0129) is for anybody holding it:
 * signed in, the card shows who you are and "Accept and join"; signed out, the
 * link waits in this browser (`invite-stash.ts`) and `_authed.tsx` brings you
 * back here once you are in.
 */
function Invite() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"checking" | "signed-out" | "signed-in" | "no-link">(
    "checking",
  );
  const [session, setSession] = useState<Session | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const invite = inviteFromFragment(window.location.hash);
    const fromFragment = inviteLinkFromFragment(window.location.hash);
    if (invite) stashInvite(invite.id, invite.token);
    if (fromFragment) stashInviteLink(fromFragment);
    if (invite || fromFragment) window.history.replaceState(null, "", window.location.pathname);
    const link = fromFragment ?? (invite ? null : stashedInviteLink());

    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setLinkToken(link);
      if (data.session && !link) {
        // An email invitation is waiting inside, with its own Accept.
        void navigate({ to: "/app", replace: true });
        return;
      }
      setSession(data.session);
      setStatus(data.session ? "signed-in" : invite || link ? "signed-out" : "no-link");
      const read = link
        ? api.inviteLinks.preview(link).then((p) => ({ ...p, kind: "link" as const }))
        : invite
          ? api.invitations
              .preview(invite.id, invite.token)
              .then((p) => ({ ...p, kind: "email" as const }))
          : null;
      read?.then(
        (found) => {
          if (active) setPreview(found);
        },
        () => {
          // The card without the workspace's name is still a way in.
        },
      );
    });
    return () => {
      active = false;
    };
  }, [navigate]);

  const join = async () => {
    if (!linkToken || joining) return;
    setJoining(true);
    setError(null);
    try {
      await api.inviteLinks.accept(linkToken);
      forgetInviteLink();
      // Joining somebody's workspace is the end of a first run, as accepting
      // an emailed invitation is.
      await api.onboarding.complete().catch(() => undefined);
      await queryClient.invalidateQueries();
      void navigate({ to: "/app", replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("Couldn't join. Try the link again."));
      setJoining(false);
    }
  };

  const switchAccount = async () => {
    await supabase.auth.signOut();
    void navigate({ to: "/sign-in" });
  };

  if (status === "checking") {
    return (
      <AuthLayout title={t("Opening your invitation")} subtitle={t("One moment.")}>
        <div className="flex min-h-16 items-center justify-center text-sm text-muted-foreground">
          {t("Loading…")}
        </div>
      </AuthLayout>
    );
  }

  if (status === "no-link") {
    return (
      <AuthLayout
        title={t("That link is incomplete")}
        subtitle={t("Open the button in your invitation email again.")}
        footer={
          <Link to="/sign-in" className="font-medium text-foreground hover:underline">
            {t("Sign in")}
          </Link>
        }
      >
        <p className="m-0 text-sm text-muted-foreground">
          {t(
            "An invitation link carries a code at the end. If the email is old, ask whoever invited you to send a new one.",
          )}
        </p>
      </AuthLayout>
    );
  }

  if (preview && !preview.open) {
    return (
      <AuthLayout
        title={t("This invitation has expired")}
        subtitle={t("It was for {{workspace}}.", { workspace: preview.workspaceName })}
        footer={
          <Link to="/sign-in" className="font-medium text-foreground hover:underline">
            {t("Sign in")}
          </Link>
        }
      >
        <p className="m-0 text-sm text-muted-foreground">
          {preview.inviterName
            ? t("Ask {{name}} to send a new one. Invitations last seven days.", {
                name: preview.inviterName,
              })
            : t("Ask whoever invited you to send a new one. Invitations last seven days.")}
        </p>
      </AuthLayout>
    );
  }

  const counts =
    preview && preview.memberCount != null && preview.agentCount != null
      ? `${t("{{count}} member", { count: preview.memberCount, defaultValue_other: "{{count}} members" })} · ${t("{{count}} agent", { count: preview.agentCount, defaultValue_other: "{{count}} agents" })}`
      : null;
  const days = daysLeft(preview?.expiresAt, now);
  const expiry =
    days === null
      ? null
      : days === 1
        ? t("The invitation expires tomorrow.")
        : t("The invitation expires in {{count}} day.", {
            count: days,
            defaultValue_other: "The invitation expires in {{count}} days.",
          });
  const me = session?.user;

  return (
    <AuthLayout
      title={
        !preview
          ? t("You've been invited")
          : preview.inviterName
            ? t("{{name}} invited you to {{workspace}}", {
                name: preview.inviterName,
                workspace: preview.workspaceName,
              })
            : t("Someone invited you to {{workspace}}", { workspace: preview.workspaceName })
      }
      subtitle={
        preview ? (
          <Trans
            t={t}
            i18nKey="As a <b>{{role}}</b>: {{sentence}}"
            values={{
              role: ROLE_WORD[preview.role] ? lookup(t, ROLE_WORD[preview.role]) : preview.role,
              sentence: ROLE_SENTENCE[preview.role]
                ? lookup(t, ROLE_SENTENCE[preview.role])
                : t("you can use what is shared with you."),
            }}
            components={{ b: <span className="font-medium text-foreground" /> }}
          />
        ) : (
          t("Sign up or sign in with the address the invitation was sent to.")
        )
      }
      footer={
        preview?.inviterName ? t("Invited by {{name}}", { name: preview.inviterName }) : undefined
      }
    >
      {preview ? (
        <div className="-mt-1 mb-4 flex items-center gap-3">
          <Tile label={preview.workspaceName} size={36} tone="ink" letters={1} />
          <div className="min-w-0">
            <div className="truncate text-lead font-semibold">{preview.workspaceName}</div>
            {counts ? <div className="text-meta text-muted-foreground">{counts}</div> : null}
          </div>
        </div>
      ) : null}

      {status === "signed-in" && me ? (
        <>
          <div className="mb-3 flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5">
            <Avatar name={(me.user_metadata?.name as string | undefined) ?? me.email} size={24} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {(me.user_metadata?.name as string | undefined) ?? me.email}
              </div>
              <div className="truncate text-meta text-muted-foreground">{me.email}</div>
            </div>
            <span className="ml-auto text-xs text-muted-foreground">{t("signed in")}</span>
          </div>
          <Button size="lg" className="w-full" disabled={joining} onClick={() => void join()}>
            {joining
              ? t("Joining…")
              : preview?.workspaceName
                ? t("Accept and join {{workspace}}", { workspace: preview.workspaceName })
                : t("Accept and join the workspace")}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className="mt-2 w-full"
            onClick={() => void switchAccount()}
          >
            {t("Use a different account")}
          </Button>
          {error ? <p className="mt-3 mb-0 text-sm text-destructive">{error}</p> : null}
        </>
      ) : (
        <>
          {preview?.kind === "email" ? (
            <p className="mt-0 mb-4 text-sm text-muted-foreground">
              <Trans
                t={t}
                i18nKey="Sign up or sign in as <b>{{email}}</b>. The invitation will be waiting inside, with a button to accept it."
                values={{ email: (preview as InvitationPreview).email }}
                components={{ b: <strong className="font-medium text-foreground" /> }}
              />
            </p>
          ) : null}
          <Button asChild size="lg" className="w-full">
            <Link to="/sign-up">{t("Create an account")}</Link>
          </Button>
          <Button asChild size="lg" variant="ghost" className="mt-2 w-full">
            <Link to="/sign-in">{t("Sign in")}</Link>
          </Button>
        </>
      )}

      <p className="mt-4 mb-0 text-meta leading-[1.5] text-muted-foreground">
        {expiry ? `${expiry} ` : ""}
        {t("Not expecting this? You can ignore it; nothing happens until you accept.")}
      </p>
    </AuthLayout>
  );
}

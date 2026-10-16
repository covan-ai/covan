import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase/client";
import { inviteFromFragment, stashInvite } from "@/lib/invite-stash";
import { api, type InvitationPreview } from "@/lib/api-client";

/**
 * Where an invitation email's button lands: `/invite#id=…&token=…`.
 *
 * The token is what accepting asks for (migration 0090): holding the email is
 * the proof that its reader is the invitee, where before an account at the
 * invited address was enough — and an install that auto-confirms sign-ups
 * handed that address to whoever signed up first.
 *
 * This page does three things and deliberately not a fourth:
 *
 * 1. Keeps the token in this browser (`lib/invite-stash.ts`) and takes it out
 *    of the address bar, so it is not in the history, a screenshot, or the
 *    URL somebody copies to ask for help.
 * 2. Sends somebody already signed in into the app, where the invitation is
 *    waiting with its Accept button.
 * 3. Offers anybody else sign-up or sign-in, with the address it has to be.
 *
 * Before sign-in it also asks what the link is an invitation to
 * (`POST /invitations/preview`, 0114), so the page can name the workspace, who
 * sent it and the address to use. That read is all it is; if it fails the
 * page says what it said before.
 *
 * It never accepts. Mail scanners open links, and a link that joined
 * workspaces on opening would join them to whoever's session is in the
 * browser that opened it. Accepting is a button, pressed.
 *
 * The fragment is read in an effect, not during render: it never reaches the
 * server, so a server render cannot know it, and reading it once the page is
 * in the browser keeps the two renders the same.
 */
export const Route = createFileRoute("/invite")({
  component: Invite,
});

function Invite() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"checking" | "signed-out" | "no-link">("checking");
  const [preview, setPreview] = useState<InvitationPreview | null>(null);

  useEffect(() => {
    const invite = inviteFromFragment(window.location.hash);
    if (invite) {
      stashInvite(invite.id, invite.token);
      window.history.replaceState(null, "", window.location.pathname);
    }

    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) {
        void navigate({ to: "/app", replace: true });
      } else {
        setStatus(invite ? "signed-out" : "no-link");
        if (invite) {
          api.invitations.preview(invite.id, invite.token).then(
            (found) => {
              if (active) setPreview(found);
            },
            () => {
              // A wrong, used or missing link and a network failure all leave
              // the page as it was: generic, and still a way in.
            },
          );
        }
      }
    });
    return () => {
      active = false;
    };
  }, [navigate]);

  if (status === "checking") {
    return (
      <AuthLayout title="Opening your invitation" subtitle="One moment.">
        <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      </AuthLayout>
    );
  }

  if (status === "no-link") {
    return (
      <AuthLayout
        title="That link is incomplete"
        subtitle="Open the button in your invitation email again."
        footer={
          <Link to="/sign-in" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        }
      >
        <p className="py-2 text-center text-sm text-muted-foreground">
          An invitation link carries a code at the end. If the email is old, ask whoever invited you
          to send a new one.
        </p>
      </AuthLayout>
    );
  }

  if (preview && !preview.open) {
    return (
      <AuthLayout
        title="This invitation has expired"
        subtitle={`It was for ${preview.workspaceName}.`}
        footer={
          <Link to="/sign-in" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        }
      >
        <p className="py-2 text-center text-sm text-muted-foreground">
          Ask {preview.inviterName ?? "whoever invited you"} to send a new one. Invitations last
          seven days.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={preview ? `Join ${preview.workspaceName}` : "You've been invited"}
      subtitle={
        preview
          ? `${preview.inviterName ?? "Someone"} invited you as ${preview.role}.`
          : "Sign up or sign in with the address the invitation was sent to."
      }
    >
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">
          <Mail className="h-5 w-5" />
        </span>
        {preview ? (
          <p className="text-sm text-muted-foreground">
            Sign up or sign in as{" "}
            <strong className="font-medium text-foreground">{preview.email}</strong>. The invitation
            will be waiting inside, with a button to accept it.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            The invitation will be waiting inside, with a button to accept it. Nothing happens until
            you press it.
          </p>
        )}
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          <Button asChild size="sm">
            <Link to="/sign-up">Create an account</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/sign-in">Sign in</Link>
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SaveLoginInput } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The card at a login wall, inside the browser panel (Task 2.4).
 *
 * It replaces the Phase 1 prompt, on the same trigger (`signInFor`: the newest
 * v4 task stopped `login_required`, in a browser still there, not itself the
 * retry), and offers three ways through in the plan's words:
 *
 * - **Just this once** — the take-over it always was: the person signs in in
 *   the browser with their own hands, presses Done, and nothing is stored.
 *   Covan never receives that password; it is typed at the site.
 * - **Save for me** — the login is kept for this agent, for this person's runs.
 * - **Save for everyone using this agent** — kept for the agent, for anyone
 *   who uses it. The list shows them its name, never the login — but they can
 *   have the agent act as that account, and watch what the browser types and
 *   what the account shows (final review #1), and the dialog says exactly that.
 *
 * The two Saves open a Covan dialog — never the frame, which is the provider's
 * page and not a place to type a password for Covan to keep — and on success
 * hand the browser back with the site named (R24): the server finds the login
 * just saved and sends it with the one free retry.
 *
 * **R33: the Saves exist only when the wall named its site.** A login is saved
 * for a site, and `signInHost` is null when the run reported none the database
 * would accept as a host. Without one the card offers Just this once alone;
 * Saving needs a site.
 *
 * **A wall after a saved login (R32).** When the run carried one
 * (`carriedSavedLogin`), the card says that login did not work and the Saves
 * read as updating it — saving replaces one's own. A shared login somebody
 * else saved is theirs to change, and the server says so in a sentence the
 * dialog shows as it is.
 *
 * **A login already saved for the site (found in the 2026-10-11 e2e).** A run
 * the model sent without `site` carries no login, meets the wall, and the
 * card used to offer to save one — a second copy of a login that exists.
 * When the server says one is saved and the run did not carry it
 * (`savedLogin`), the card offers "Try again with the saved login" instead of
 * the Saves: the same hand-back a save makes, naming that login (R35).
 *
 * **The new tab survives as the fallback**, for the reasons it was once the
 * only path: a passkey cannot work in an iframe (WebAuthn is origin-bound), and
 * a password manager rightly refuses to fill one whose origin is the
 * provider's. "Open in a new window" puts the same browser in a tab of its own.
 */
export function SignInCard({
  host,
  carriedSavedLogin,
  savedLogin = null,
  agentId,
  canShare,
  opening = false,
  onJustThisOnce,
  onOpenWindow,
  onSaved,
}: {
  /**
   * The run's `signin_host`, which 0078 stores only when it is already a bare
   * lowercase host — so it is safe to render as one. A wrong host would send
   * somebody to the wrong site, which is worse than naming none.
   */
  host: string | null;
  carriedSavedLogin: boolean;
  /** A login saved for this site that the run did not carry, offered instead of the Saves. */
  savedLogin?: { id: string; label: string; siteHost: string } | null;
  /** The agent a login would be saved for. Without one, nothing can be saved. */
  agentId: string | undefined;
  /**
   * Whether the person may save a login for everyone using the agent (R34):
   * not a viewer — 0021's "shared things need a member". From the role the
   * app already holds (`canWrite`), not a request of the card's own. The
   * server refuses a viewer's shared save regardless.
   */
  canShare: boolean;
  /** A take-over is under way; every choice waits for it. */
  opening?: boolean;
  /** Take over: the person signs in in the browser, nothing stored. */
  onJustThisOnce: () => void;
  /** The new-tab fallback. Called from the click, because the tab is reserved inside it. */
  onOpenWindow: () => void;
  /**
   * A login was saved for `siteHost`: hand the browser back with it, naming
   * the row the save returned (R35) so the run binds this login and not one
   * the ordinary order would prefer.
   */
  onSaved: (siteHost: string, credentialId: string) => void;
}) {
  const [saving, setSaving] = useState<"owner" | "agent" | null>(null);
  const reuse = !carriedSavedLogin && savedLogin ? savedLogin : null;
  const canSave = !!host && !!agentId && !reuse;
  const updating = carriedSavedLogin && canSave;

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-sm font-medium">
        {carriedSavedLogin
          ? `The saved login for ${host ?? "this site"} didn't get past the sign-in.`
          : `${host ?? "This site"} needs you to sign in.`}
      </p>
      {/* The network-address sentence was added after the first real run: a
          hand-performed LinkedIn sign-in saved, attached and ran again from
          another address in the same country, and LinkedIn asked for the
          password again. The person deciding is the one who should know. */}
      <p className="mt-1 text-meta text-muted-foreground">
        Just this once: take over and sign in in the browser, then press Done. You type your
        password at the site; Covan never receives it.
        {reuse
          ? ` Or try again with your saved login, ${reuse.label}, and the agent signs in by itself.`
          : canSave
            ? updating
              ? " Or update the saved login, and the agent tries again with it."
              : " Or save the login, and the agent signs in by itself from now on."
            : ""}{" "}
        No charge for the second attempt. Some sites tie a sign-in to one network address and will
        ask again anyway; LinkedIn is one of them.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={opening} onClick={onJustThisOnce}>
          Just this once
        </Button>
        {reuse && (
          <Button
            variant="secondary"
            size="sm"
            disabled={opening}
            onClick={() => onSaved(reuse.siteHost, reuse.id)}
          >
            Try again with the saved login
          </Button>
        )}
        {canSave && (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={opening}
              onClick={() => setSaving("owner")}
            >
              {updating ? "Update for me" : "Save for me"}
            </Button>
            {canShare && (
              <Button
                variant="secondary"
                size="sm"
                disabled={opening}
                onClick={() => setSaving("agent")}
              >
                {updating
                  ? "Update for everyone using this agent"
                  : "Save for everyone using this agent"}
              </Button>
            )}
          </>
        )}
      </div>
      {/* A link-weight control: the pill's Take over is the primary action
          while this card shows, and this is the way round the frame. */}
      <button
        type="button"
        className="mt-2 text-meta text-foreground underline underline-offset-4 hover:text-muted-foreground disabled:opacity-50"
        disabled={opening}
        onClick={onOpenWindow}
      >
        Open in a new window
      </button>

      {host && agentId && (
        <SaveLoginDialog
          // A fresh dialog — and fresh state — for each opening, so nothing
          // typed into one survives into the next.
          key={saving ?? "closed"}
          open={saving !== null}
          scope={saving ?? "owner"}
          host={host}
          agentId={agentId}
          onClose={() => setSaving(null)}
          onSaved={(siteHost, credentialId) => {
            setSaving(null);
            onSaved(siteHost, credentialId);
          }}
        />
      )}
    </div>
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Couldn't save that login.";
}

/**
 * The dialog behind the two Saves: the site, username, password, and a name
 * for the login.
 *
 * **The site is the person's to confirm (R37)**, prefilled from the wall and
 * editable, because it decides where the password may ever be typed: the
 * login is bound to that host and its subdomains, so `linkedin.com` rather
 * than the `accounts.linkedin.com` the wall happened to be on is usually what
 * somebody means — and a page that talked the run into reporting another host
 * is caught here, by a person reading it, before anything is stored.
 *
 * **The password lives in this component's state, and only while it must.**
 * Not in a query key or the query cache, not in storage, not in a log line. The
 * save is a mutation, so its variables do pass through the query client — and
 * so the mutation is collected the moment it settles (`gcTime: 0`) and reset
 * after it, and the two fields are emptied on success, on a refusal and on
 * close. What the server answers carries neither half.
 *
 * **The name defaults to the site and who it is for, never the username** —
 * colleagues see a shared login's name, and the server refuses one that
 * contains the username, in a sentence shown here as it is.
 *
 * `autoComplete="new-password"` keeps the browser from filling Covan's own
 * password into a field meant for another site's, and `off` on the username
 * does the same for Covan's sign-in address.
 *
 * **"Update" only when it is one.** A save replaces the caller's own login of
 * the same scope for this site on this agent, and otherwise adds a row — so a
 * run that carried somebody's personal login, followed by "for everyone",
 * makes a second, shared login rather than updating anything. The title asks
 * the agent's list (one request, when the dialog opens; never in the poll),
 * which names only labels, hosts and scopes.
 */
function SaveLoginDialog({
  open,
  scope,
  host,
  agentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  scope: "owner" | "agent";
  host: string;
  agentId: string;
  onClose: () => void;
  onSaved: (siteHost: string, credentialId: string) => void;
}) {
  const queryClient = useQueryClient();
  // The same key `SavedLoginsList` reads one agent's logins under.
  const { data: existing } = useQuery({
    queryKey: ["browser-credentials", agentId],
    queryFn: () => api.browser.credentials.list(agentId),
    enabled: open,
  });
  // R37: the site, shown and editable, prefilled from the wall's host. That
  // host is a run's report of the page it stopped on — a page can steer it,
  // and a wall on `accounts.` would file the login under the subdomain — so
  // what is saved is what the person confirms here. The server normalises it
  // (R25) and answers the host it kept, which the hand-back then names.
  const [site, setSite] = useState(host);
  const shown = site.trim() || host;
  const siteHost = shown.toLowerCase().replace(/^www\./, "");
  const replaces = !!existing?.logins.some(
    (l) => l.own && l.scope === scope && l.siteHost === siteHost,
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState(`${host} — ${scope === "agent" ? "shared" : "personal"}`);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: SaveLoginInput) => api.browser.credentials.save(input),
    gcTime: 0,
  });

  function forgetTyped() {
    setUsername("");
    setPassword("");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    try {
      const saved = await save.mutateAsync({
        agentId,
        scope,
        site: site.trim(),
        label,
        username,
        password,
      });
      forgetTyped();
      void queryClient.invalidateQueries({ queryKey: ["browser-credentials"] });
      onSaved(saved.credential.siteHost, saved.credential.id);
    } catch (err) {
      forgetTyped();
      setProblem(messageOf(err));
    } finally {
      save.reset();
    }
  }

  const title = replaces
    ? `Update the saved login for ${shown}`
    : scope === "agent"
      ? `Save a login for ${shown}, for everyone`
      : `Save a login for ${shown}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        forgetTyped();
        setProblem(null);
        onClose();
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {scope === "agent"
                ? `Anyone who uses this agent can have it sign in and act as this account on ${shown}. The list shows them only its name, but they can see what the browser types and what the account shows.`
                : `Only your runs of this agent sign in to ${shown} with it.`}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="save-login-site">Site</Label>
            <Input
              id="save-login-site"
              autoComplete="off"
              spellCheck={false}
              value={site}
              onChange={(e) => setSite(e.target.value)}
              aria-describedby="save-login-site-check"
            />
            <p id="save-login-site-check" className="text-meta text-muted-foreground">
              Check this is the site you mean — the login will only ever be typed on this site and
              its subdomains.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="save-login-username">Username</Label>
            <Input
              id="save-login-username"
              autoComplete="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="save-login-password">Password</Label>
            <Input
              id="save-login-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="save-login-label">Name</Label>
            <Input
              id="save-login-label"
              autoComplete="off"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          {/* V4's inline bindings carry no one-time codes; only 1Password does. */}
          <p className="text-meta text-muted-foreground">
            Codes, SMS and passkeys still need you — the browser will ask.
          </p>

          {problem && (
            <p role="alert" className="text-sm leading-[1.45] text-destructive">
              {problem}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                forgetTyped();
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending || !site.trim() || !username.trim() || !password || !label.trim()
              }
            >
              Save and continue
            </Button>
          </DialogFooter>

          <p className="text-meta text-muted-foreground">
            Covan never gives your password to the AI model. It is encrypted, and typed into {shown}{" "}
            by the browser provider only.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}

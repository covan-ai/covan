import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { keyHint } from "@/lib/provider-keys";
import { isAdminRole } from "@/lib/roles";
import { ProviderKeyForm } from "@/components/provider-key-form";

/**
 * Door one, on its own, because it is the only part of the wall an admin needs
 * before they reach the wall.
 *
 * This used to live inside `QuotaWall`, which mounts only once the reader's own
 * allowance is spent — and the allowance is per member. So the journey the
 * feature was designed around dead-ended: a member ran out, read "an admin of
 * this workspace can add its own OpenAI key", told their admin, and that admin —
 * who by construction still had replies left — opened Settings and found no key
 * field anywhere in the product. The same gate made a stored key unrevocable
 * until whoever wanted it gone had personally burned a month's allowance.
 *
 * So it renders on the metered deployment, for the admin, in both states.
 * `QuotaWall` keeps the two doors that only make sense at the wall itself: the
 * message form and the self-hosting paragraph, plus the sentence that tells a
 * member whose admin to ask. Nothing renders a key form but this.
 *
 * It renders nothing at all for a non-admin, and nothing where the deployment
 * has no `PROVIDER_KEY_SECRET` and therefore nowhere to put a key — a form that
 * would only ever answer 501 is worse than no form.
 */
export function WorkspaceProviderKeys() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: keys } = useQuery({
    queryKey: ["provider-keys"],
    queryFn: () => api.providerKeys.get(),
  });

  // The house pattern — `Me.workspace` carries no role. See settings.tsx:202.
  const myRole = me?.members.find((m) => m.id === me.user.id)?.role;

  // `false` until `me` loads, unlike settings.tsx which defaults to `true`.
  // The cost of guessing wrong is asymmetric here: showing a key field to
  // somebody who may not be able to set one invites them to paste a live
  // credential into a form that will refuse it, and this is the one field in
  // the product where a moment of "ask your admin" is worth more than a form
  // that flashes into existence and then locks.
  const isAdmin = me ? isAdminRole(myRole) : false;

  if (!isAdmin || !keys?.configured) return null;

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-hairline pt-3">
      {/* Written to be true whether or not the person reading it has replies
          left of their own, because they now see this in both states. "Whenever
          somebody here runs out" is the fact in either case: as a preparation
          before anybody has, and as the remedy for the member who just did.
          "Carries on from here", the old wording, quietly assumed the reader
          was the one who had run out. */}
      <p className="text-xs text-muted-foreground">
        Set the workspace's own key and Covan carries on with it whenever somebody here runs out.
        Each person spends their monthly allowance first; only what runs past it is billed to you.
      </p>
      <ProviderKeyForm
        provider="openai"
        label="OpenAI key"
        placeholder="sk-…"
        hint={keyHint(keys.openai)}
      />
      <ProviderKeyForm
        provider="anthropic"
        label="Anthropic key (optional)"
        placeholder="sk-ant-…"
        hint={keyHint(keys.anthropic)}
      />

      {/* The one wrong state this form can be left in, and the only one worth
          saying out loud. "Optional" is true of the Anthropic field and false
          of the pair: `keysForUser` refuses to take over without an OpenAI key,
          because embeddings, dictation and the default model all need one. So
          an admin who fills in the second field and stops has done something
          that looks finished, saves cleanly, shows a hint back — and changes
          nothing. Without this line their only other feedback is a usage screen
          that still says paused, with nothing anywhere connecting the two.

          Not `text-destructive`: nothing failed, and DESIGN.md keeps that token
          for engine-level failures. This is a step missing, which is what the
          amber accent is for. */}
      {!keys.openai && keys.anthropic && (
        <p className="text-xs text-accent-orange">
          An Anthropic key on its own carries nothing. Covan needs the OpenAI key to take over —
          embeddings, dictation and the default model all run on it — so until that one is set,
          people here will keep running out.
        </p>
      )}
    </div>
  );
}

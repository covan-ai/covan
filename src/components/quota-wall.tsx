import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { isAdminRole } from "@/lib/roles";
import { DocsLink } from "@/components/docs-link";
import { ProviderKeyForm } from "@/components/provider-key-form";
import { QuotaSupportForm } from "@/components/quota-support-form";

/**
 * What somebody finds when the month's allowance is gone.
 *
 * Three answers, nearest first. The workspace's own key continues from here and
 * is the only one that changes anything today; a message reaches us and is the
 * only one that changes anything about next month; self-hosting is the thorough
 * option and was, until this, the only one offered.
 *
 * A member and a viewer cannot set a key — that is an admin's to do — but both
 * get the form. Somebody who hit the wall is the warmest signal the product
 * produces, and a second one from the same company is worth more than the first.
 */
export function QuotaWall() {
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

  return (
    <div className="mt-3 flex flex-col gap-4 border-t border-hairline pt-3">
      {/* Door one. Only an admin can walk through it, and only where the
          deployment can store a key at all — a self-host without
          PROVIDER_KEY_SECRET has nowhere to put one, and `configured` says so
          before anybody types anything into a form that would just 501. */}
      {keys?.configured &&
        (isAdmin ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Point the workspace at its own key and it carries on from here. Each person still
              spends their allowance first; only what runs past it is billed to you.
            </p>
            <ProviderKeyForm
              provider="openai"
              label="OpenAI key"
              placeholder="sk-…"
              hint={keys.openai}
            />
            <ProviderKeyForm
              provider="anthropic"
              label="Anthropic key (optional)"
              placeholder="sk-ant-…"
              hint={keys.anthropic}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            An admin of this workspace can add its own OpenAI key, and everyone who runs out carries
            on from there.
          </p>
        ))}

      {/* Door two, for everybody — admin, member and viewer alike. */}
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">Or tell us what you need.</p>
        <QuotaSupportForm />
      </div>

      {/* The thorough option, which was the only one until now. Unchanged from
          usage-section.tsx, moved down to third. */}
      <p className="text-xs text-muted-foreground">
        Covan is open source, and an install running on your own OpenAI key has no allowance at all
        — everything here works the same way.{" "}
        <DocsLink page="self-hosting" className="text-xs">
          Running it yourself
        </DocsLink>
      </p>
    </div>
  );
}

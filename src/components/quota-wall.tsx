import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { isAdminRole } from "@/lib/roles";
import { DocsLink } from "@/components/docs-link";
import { QuotaSupportForm } from "@/components/quota-support-form";

/**
 * What somebody finds when the month's allowance is gone.
 *
 * Three answers, nearest first. The workspace's own key continues from here and
 * is the only one that changes anything today; a message reaches us and is the
 * only one that changes anything about next month; self-hosting is the thorough
 * option and was, until this, the only one offered.
 *
 * Only the last two are rendered here. Door one's *field* is
 * `WorkspaceProviderKeys`, which `UsageSection` mounts above this one and mounts
 * whether or not the reader has run out — because the allowance is per member,
 * and the admin who has to set the key is usually not the person who hit the
 * wall. What stays here is the half of door one that only makes sense at the
 * wall: telling a member whose admin to ask. Nothing renders a key form but that
 * component.
 *
 * A member and a viewer cannot set a key — that is an admin's to do — but both
 * get the message form. Somebody who hit the wall is the warmest signal the
 * product produces, and a second one from the same company is worth more than
 * the first.
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
  // Here that default decides whether somebody is told to go and ask their
  // admin, and telling an admin to ask an admin for a moment is a smaller
  // wrong than staying silent about the door that would actually open for
  // them. The field itself makes the same conservative choice for the sharper
  // reason — see `workspace-provider-keys.tsx`.
  const isAdmin = me ? isAdminRole(myRole) : false;

  return (
    <div className="mt-3 flex flex-col gap-4 border-t border-hairline pt-3">
      {/* The half of door one that belongs at the wall. An admin does not need
          it: their field is already above this. Shown only where the deployment
          can store a key at all — a self-host without PROVIDER_KEY_SECRET has
          nowhere to put one, and pointing somebody at an admin who would find
          no field is worse than saying nothing. */}
      {keys?.configured && !isAdmin && (
        <p className="text-xs text-muted-foreground">
          An admin of this workspace can add its own OpenAI key, and everyone who runs out carries
          on from there.
        </p>
      )}

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

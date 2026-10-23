import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";

import { api } from "@/lib/api-client";
import { isAdminRole } from "@/lib/roles";
import { DocsLink } from "@/components/docs-link";
import { QuotaSupportForm } from "@/components/quota-support-form";

/**
 * What somebody finds when the workspace's credits are gone.
 *
 * Two answers, nearest first. A message reaches us, and credits are added by
 * hand until there is a checkout; self-hosting is the thorough option, and an
 * install running on its own keys has no credits at all.
 *
 * Everybody gets the message form — admin, member and viewer alike. Somebody
 * who hit the wall is the warmest signal the product produces, and a second one
 * from the same company is worth more than the first. An admin is told that
 * top-ups are manual for now, because they are the person who would otherwise
 * go looking for a button that does not exist yet.
 */
export function CreditsWall() {
  const { t } = useTranslation();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });

  // The house pattern — `Me.workspace` carries no role. See `useWorkspaceRole`
  // in `lib/workspace-role.ts`.
  const myRole = me?.members.find((m) => m.id === me.user.id)?.role;
  const isAdmin = me ? isAdminRole(myRole) : false;

  return (
    <div className="mt-3 flex flex-col gap-4 border-t border-hairline pt-3">
      <div className="flex flex-col gap-2">
        <p className="text-meta text-muted-foreground">
          {isAdmin
            ? t("Top-ups are handled by hand for now — tell us how many credits you need.")
            : t("Ask us for more credits, or ask an admin of this workspace to.")}
        </p>
        <QuotaSupportForm />
      </div>

      <p className="text-meta text-muted-foreground">
        {t(
          "Covan's full source is published, and an install running on your own provider keys has no credits at all — everything here works the same way.",
        )}{" "}
        <DocsLink page="self-hosting" className="text-xs">
          {t("Running it yourself")}
        </DocsLink>
      </p>
    </div>
  );
}

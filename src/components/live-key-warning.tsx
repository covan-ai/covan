import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { api } from "@/lib/api-client";

/**
 * The one thing removing somebody does destroy.
 *
 * The dialog this sits in says nothing is lost and invites them back to prove
 * it, which is true of everything except this. An API key acts as its owner, so
 * it stops the moment their membership does — and it does not come back with
 * them, because revocation is one-way. A script running on that key simply goes
 * quiet, at whatever hour it next runs.
 *
 * It asks only when the dialog is open, because that is when this component
 * mounts. `count === null` is a deployment whose migration has not been applied
 * yet, and an unanswerable question is one this dialog does not raise — a
 * warning about a feature nobody here has is worse than no warning at all.
 */
export function LiveKeyWarning({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["api-keys", "count", userId],
    queryFn: () => api.workspace.members.keyCount(userId),
    // Admin-only on the server, and an admin is the only person who can open
    // the dialog this lives in — but somebody who somehow does should see
    // nothing rather than an error, so a refusal is an absent sentence.
    retry: false,
  });

  const count = data?.count ?? 0;
  if (count === 0) return null;

  return (
    <p className="text-sm text-muted-foreground">
      {t(
        "They have {{count}} API key that is still in use. It will stop working immediately, and anything scheduled against it will go quiet.",
        {
          count,
          defaultValue_other:
            "They have {{count}} API keys that are still in use. They will stop working immediately, and anything scheduled against them will go quiet.",
        },
      )}
    </p>
  );
}

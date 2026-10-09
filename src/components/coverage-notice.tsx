import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { useCoverageNoticeDismissed } from "@/lib/coverage-notice";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";

/**
 * Told once, with the choice in front of them.
 *
 * `coverage_opt_outs` (0076) lets any member exclude themselves from the
 * coverage report, and a control nobody knows about is not a control — without
 * this, that sentence is true only of people who go looking in Settings. It is
 * one of the three things standing in for the per-asker consent step 0053 asked
 * for, so it has to actually reach somebody.
 *
 * **Dismissal is `localStorage`; the exclusion is the server row.** Two
 * different facts: being told is about this person having seen it, and the row
 * is their decision. The dismissal pattern is `useChecklistDismissed`'s in
 * `src/lib/first-week.ts` — read through `useSyncExternalStore` rather than
 * copied into state after mount, keyed per workspace, and surviving storage
 * that throws by showing the notice again, which is the harmless direction.
 * It lives in `@/lib/coverage-notice` rather than here, for the same reason
 * `useChecklistDismissed` lives in `lib/` rather than in
 * `first-week-checklist.tsx`: a file exporting both a hook and a component
 * trips `react-refresh/only-export-components`.
 *
 * Deliberately NOT a tenth transactional email. The nine are a careful set and
 * three of them Supabase sends by hand; an email about a report that may never
 * clear its floor is noise, and a notice is actionable in place with no
 * deliverability question in front of it. This replaces that email rather than
 * deferring it.
 */
export function CoverageNotice({
  workspaceId,
  enabled,
}: {
  workspaceId: string;
  enabled: boolean;
}) {
  const { dismissed, dismiss } = useCoverageNoticeDismissed(workspaceId);
  const [excluding, setExcluding] = useState(false);

  // Skipped once dismissed — a member who has already been told costs this
  // workspace nothing more. Skipped while the workspace has not turned the
  // report on at all: there is nothing yet to be told about.
  const { data } = useQuery({
    queryKey: ["coverage", "preference", workspaceId],
    queryFn: () => api.coverage.preference(),
    enabled: enabled && !dismissed,
  });

  const exclude = async () => {
    if (excluding) return;
    setExcluding(true);
    try {
      await api.coverage.setPreference(true);
      dismiss();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save that — try again.");
    } finally {
      setExcluding(false);
    }
  };

  // Hidden when the workspace has not turned it on, once dismissed, while the
  // preference is still loading (no spinner on a notice — same choice
  // `WorkspaceCoverageSection` makes), and for somebody who already opted out:
  // showing it again would be asking a question they already answered.
  if (!enabled || dismissed || !data || data.excluded) return null;

  return (
    <SectionCard className="mt-8">
      <p className="text-sm leading-[1.45]">
        <span className="font-medium text-foreground">Your admin turned on a coverage report.</span>{" "}
        Once a week it shows which topics the team asked about that no document covered — clustered
        topics only, from at least three different people, or every topic if you&rsquo;re the only
        member here. It never shows names and never shows anybody&rsquo;s question. You can leave
        your questions out, now or later in Settings.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={exclude} disabled={excluding}>
          {excluding ? "Excluding…" : "Exclude my questions"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
          Keep me in
        </Button>
      </div>
    </SectionCard>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { TopBar } from "@/components/top-bar";
import { PageBody } from "@/components/page";
import { ThreadsTable } from "@/components/threads-table";
import { NewThreadButton } from "@/components/new-thread-button";
import { api } from "@/lib/api-client";

export const Route = createFileRoute("/_authed/threads")({
  component: ThreadsPage,
  head: () => ({ meta: [{ title: "Threads — Covan" }] }),
});

/** Every thread you can see (A5). */
function ThreadsPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  // The totals ride on any page of the table; this asks for the smallest the
  // API serves (`GET /sessions/table` refuses a page under five).
  const { data } = useQuery({
    queryKey: ["sessions", "table", "totals"],
    queryFn: () => api.sessions.table({ pageSize: 5 }),
  });
  const meta = data
    ? t("{{thisWeek}} this week · {{allTime}} all time", {
        thisWeek: data.thisWeek.toLocaleString(locale),
        allTime: data.allTime.toLocaleString(locale),
      })
    : undefined;
  return (
    <>
      <TopBar title={t("Threads")} meta={meta} actions={<NewThreadButton />} />
      <PageBody width="table" className="lg:pt-5">
        <ThreadsTable />
      </PageBody>
    </>
  );
}

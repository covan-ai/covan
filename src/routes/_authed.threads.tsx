import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
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
  // The totals ride on any page of the table; this asks for the smallest.
  const { data } = useQuery({
    queryKey: ["sessions", "table", "totals"],
    queryFn: () => api.sessions.table({ pageSize: 1 }),
  });
  const meta = data
    ? `${data.thisWeek.toLocaleString("en-US")} this week · ${data.allTime.toLocaleString("en-US")} all time`
    : undefined;
  return (
    <>
      <TopBar title="Threads" meta={meta} actions={<NewThreadButton />} />
      <PageBody width="table" className="lg:pt-5">
        <ThreadsTable />
      </PageBody>
    </>
  );
}

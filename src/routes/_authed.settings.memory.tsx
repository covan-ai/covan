import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { api } from "@/lib/api-client";
import { useWorkspaceRole } from "@/lib/workspace-role";
import { DocsLink } from "@/components/docs-link";
import { SectionTitle } from "@/components/section";
import { MemoryNotesSection } from "@/components/settings/memory-notes-section";

export const Route = createFileRoute("/_authed/settings/memory")({
  component: MemorySettingsPage,
  head: () => ({
    meta: [
      { title: "Memory — Settings — Covan" },
      { name: "description", content: "What the agents keep in mind about your team and you." },
    ],
  }),
});

function MemorySettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { canWrite } = useWorkspaceRole();
  const { data } = useQuery({ queryKey: ["memory"], queryFn: () => api.memory.list() });
  const notes = data?.notes ?? [];
  const changed = () => void queryClient.invalidateQueries({ queryKey: ["memory"] });

  return (
    <>
      <SectionTitle
        title={t("Memory")}
        lede={
          <>
            {t("What the agents keep in mind about this team, and about you.")}{" "}
            <DocsLink page="knowledge">{t("Learn more")}</DocsLink>
          </>
        }
      />
      <div className="mt-5">
        <MemoryNotesSection
          label={t("About the team")}
          lede={t("Everyone in this workspace can read these, and so can the agents.")}
          notes={notes.filter((n) => n.scope === "workspace")}
          canAdd={canWrite}
          about="team"
          onChanged={changed}
        />
        <MemoryNotesSection
          label={t("About you", { context: "memory", defaultValue: "About you" })}
          lede={t("Only you can see these. Agents keep them in mind when they work with you.")}
          notes={notes.filter((n) => n.mine && n.scope === "owner")}
          canAdd
          about="person"
          onChanged={changed}
        />
      </div>
    </>
  );
}

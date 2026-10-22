import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/components/section";
import { SectionHeading } from "@/components/page-container";
import { WorkspaceForm } from "@/components/settings/workspace-form";
import { DefaultModelSection } from "@/components/preferences-section";
import { useWorkspaceRole } from "@/lib/workspace-role";

export const Route = createFileRoute("/_authed/settings/general")({
  component: GeneralSettingsPage,
  head: () => ({
    meta: [
      { title: "General — Settings — Covan" },
      { name: "description", content: "Your workspace's name and default model in Covan." },
    ],
  }),
});

function GeneralSettingsPage() {
  const { me, isAdmin: isAdminOnceKnown } = useWorkspaceRole();

  // True while `me` loads, unlike the hook's own answer, so the form does not
  // visibly lock and then unlock on every cold load — mirrors the same choice
  // in agents-store. Nothing is fetched on the strength of it: the sections
  // gated below on `isAdmin` ask a server that refuses anybody else anyway.
  const isAdmin = me ? isAdminOnceKnown : true;

  return (
    <>
      <SectionTitle title="General" lede="What the workspace is called, and what it answers on." />

      <section className="mt-8">
        <SectionHeading
          title="Workspace"
          description={isAdmin ? undefined : "The name and slug are an admin's to change."}
        />
        {/* Read-only for everybody but an admin. `workspaces_update_admin` has
            always refused this write, and PATCH /workspace answers 403 — but
            the form was rendered to everyone, so a member could fill it in,
            press Save and be told they had done something wrong. `key` seeds
            it: "pending" while `me` loads, then the id. */}
        <WorkspaceForm
          key={me?.workspace.id ?? "pending"}
          workspace={me?.workspace}
          isAdmin={isAdmin}
        />
      </section>

      {/* The workspace's default model is an admin's; a member's own
          preference is under Preferences. */}
      {isAdmin && <DefaultModelSection me={me} />}
    </>
  );
}

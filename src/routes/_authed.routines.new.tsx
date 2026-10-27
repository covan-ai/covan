import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RoutineEditor } from "@/components/routines/routine-editor";

export const Route = createFileRoute("/_authed/routines/new")({
  component: NewRoutine,
  // `?agent=` from an agent's Routines tab; `?template=` from a link that
  // names one of the routine cards in `use-cases.ts` — renaming one breaks it;
  // `?focus=sentence` from the use-cases page's "Describe it in a sentence".
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent?: string; template?: string; focus?: "sentence" } => ({
    agent: typeof search.agent === "string" ? search.agent : undefined,
    template: typeof search.template === "string" ? search.template : undefined,
    focus: search.focus === "sentence" ? "sentence" : undefined,
  }),
  head: () => ({ meta: [{ title: "New routine — Covan" }] }),
});

/** A routine from nothing (A28), beside the list. */
function NewRoutine() {
  const { agent, template, focus } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <RoutineEditor
      initialAgentId={agent}
      templateId={template}
      focusSentence={focus === "sentence"}
      cancelTo={agent ? `/agents/${agent}/routines` : "/routines"}
      onSaved={(id) => void navigate({ to: "/routines/$routineId", params: { routineId: id } })}
    />
  );
}

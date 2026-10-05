import {
  ROUTINE_TEMPLATES,
  requirementReason,
  unmetRequirements,
  type RoutineTemplate,
  type TemplateFacts,
} from "@/lib/routine-templates";
import { cn } from "@/lib/utils";

/**
 * The templates, with the reason any of them cannot be used right now.
 *
 * One reason, not a list, even where several requirements are unmet: the card is
 * two lines and the first unmet thing is the one to go and do. Somebody who is
 * not an admin does not also need telling that the feature is off.
 */
export function TemplatePicker({
  facts,
  onPick,
}: {
  facts: TemplateFacts;
  onPick: (template: RoutineTemplate) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {ROUTINE_TEMPLATES.map((template) => {
        const unmet = unmetRequirements(template, facts);
        const blocked = unmet.length > 0;

        return (
          <button
            key={template.id}
            type="button"
            disabled={blocked}
            onClick={() => onPick(template)}
            className={cn(
              "flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors duration-200",
              blocked ? "opacity-60" : "hover:bg-surface",
            )}
          >
            <span aria-hidden className="mt-px text-base leading-none">
              {template.emoji}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{template.label}</span>
              <span className="mt-0.5 block text-meta leading-[1.45] text-muted-foreground">
                {blocked ? requirementReason(unmet[0]) : template.blurb}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

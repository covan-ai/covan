import {
  NEW_AGENT_SHARING,
  NEW_AGENT_SHARING_LABEL,
  type NewAgentSharing,
} from "@/lib/agent-access";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * "Who can use it", while the agent is being made.
 *
 * Starts on Only me, as the server does: an agent somebody is still building
 * is theirs until they say otherwise. Shared by both places an agent is made,
 * so the two cannot offer different choices or name them differently.
 */
export function NewAgentSharingSelect({
  value,
  onChange,
  labelClassName,
}: {
  value: NewAgentSharing;
  onChange: (value: NewAgentSharing) => void;
  labelClassName?: string;
}) {
  return (
    <div className="space-y-2">
      <Label className={labelClassName} htmlFor="new-agent-sharing">
        Who can use it
      </Label>
      <Select value={value} onValueChange={(v) => onChange(v as NewAgentSharing)}>
        <SelectTrigger id="new-agent-sharing">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {NEW_AGENT_SHARING.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {NEW_AGENT_SHARING_LABEL[choice]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {value === "only"
          ? "Just you while you build it. Share it with the team, or with specific people, whenever it's ready."
          : value === "use"
            ? "Everyone can chat with it. Changing how it's set up stays with you and the admins."
            : "Everyone can chat with it and change how it's set up."}
      </p>
    </div>
  );
}

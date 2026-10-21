import { useEffect, useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChoiceCards } from "@/components/welcome/choice-cards";
import { EMOJIS } from "@/lib/agent-meta";
import {
  CUSTOM_ROLE,
  DEFAULT_EMOJI,
  DEFAULT_ROLE,
  ROLES,
  defaultAssistantName,
  type Emoji,
} from "@/lib/onboarding-config";
import { cn } from "@/lib/utils";

export type AssistantAnswer = {
  assistantName: string;
  assistantEmoji: Emoji;
  assistantRole: string;
};

/**
 * The assistant's name and face.
 *
 * Four cards, the first already chosen: "<Name>'s assistant", filled from the
 * profile, so continuing without touching anything is a real answer and costs
 * one click. The other three are ready-made assistants with names of their
 * own; picking one fills the name and the emoji. Typing a name of one's own
 * un-picks the cards and records the role as `custom`.
 *
 * Nothing is created here. The agent is made at the end of the run from what
 * this step recorded (0119), which is what stops a reload of this screen
 * from making a second one.
 */
export function AssistantStep({
  formId,
  firstName,
  value,
  onSubmit,
  onValidityChange,
}: {
  formId: string;
  firstName: string | null | undefined;
  value: {
    assistantName: string | null;
    assistantEmoji: string | null;
    assistantRole: string | null;
  };
  onSubmit: (answer: AssistantAnswer) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const defaultName = defaultAssistantName(firstName);
  const [role, setRole] = useState(value.assistantRole ?? DEFAULT_ROLE);
  const [name, setName] = useState(value.assistantName ?? defaultName);
  const [emoji, setEmoji] = useState<Emoji>(
    (EMOJIS as readonly string[]).includes(value.assistantEmoji ?? "")
      ? (value.assistantEmoji as Emoji)
      : DEFAULT_EMOJI,
  );

  const valid = name.trim().length > 0;
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);

  const cards = [
    {
      id: DEFAULT_ROLE,
      label: defaultName,
      line: "For whatever comes up.",
      emoji: DEFAULT_EMOJI,
    },
    ...ROLES.map((r) => ({ id: r.id, label: r.name, line: r.line, emoji: r.emoji })),
  ];

  const pick = (id: string) => {
    setRole(id);
    const suggestion = ROLES.find((r) => r.id === id);
    if (suggestion) {
      setName(suggestion.name);
      setEmoji(suggestion.emoji);
    } else {
      setName(defaultName);
      setEmoji(DEFAULT_EMOJI);
    }
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({ assistantName: name.trim(), assistantEmoji: emoji, assistantRole: role });
  };

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-6">
      <ChoiceCards
        name="Ready-made assistants"
        options={cards}
        value={cards.some((c) => c.id === role) ? role : null}
        onChange={pick}
        onEnter={() => (document.getElementById(formId) as HTMLFormElement | null)?.requestSubmit()}
      />

      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="assistant-name">Name</Label>
          <Input
            id="assistant-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setRole(CUSTOM_ROLE);
            }}
            maxLength={120}
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label id="assistant-emoji-label">Face</Label>
          <div
            role="radiogroup"
            aria-labelledby="assistant-emoji-label"
            className="flex flex-wrap gap-1.5"
          >
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={emoji === e}
                aria-label={`Use ${e}`}
                onClick={() => setEmoji(e)}
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-md border text-lg transition-colors duration-200",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  emoji === e
                    ? "border-border bg-surface"
                    : "border-hairline hover:bg-surface-hover",
                )}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      </div>
    </form>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { lookup, useTranslation } from "@/i18n";
import { AgentMark, AgentMarkPicker } from "@/components/agent-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { JOBS, personaFor } from "@/lib/onboarding-config";
import { cn } from "@/lib/utils";

export type AssistantAnswer = {
  assistantName: string;
  assistantAvatar: string;
  assistantJobs: string[];
  persona: string;
};

/**
 * "Set up your first agent" (A14): a name, one of the eight marks, the jobs
 * it should do, and the persona those are written into — editable here, and
 * rewritten from the choices on request. The sidebar row it will be is shown
 * underneath, so the name and the face are seen where they will live.
 */
export function AssistantStep({
  formId,
  workspaceName,
  value,
  onSubmit,
  onValidityChange,
  onNameChange,
}: {
  formId: string;
  workspaceName: string | null;
  value: {
    assistantName: string | null;
    assistantAvatar?: string | null;
    assistantJobs?: string[] | null;
  };
  onSubmit: (answer: AssistantAnswer) => void;
  onValidityChange?: (valid: boolean) => void;
  /** So the primary button outside the form can say "Create Support". */
  onNameChange?: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(value.assistantName ?? "");
  const [avatar, setAvatar] = useState<string>(value.assistantAvatar ?? "headset");
  const [jobs, setJobs] = useState<string[]>(value.assistantJobs ?? ["answer-questions"]);
  const written = personaFor({ workspaceName, jobs });
  // Null while the persona is still the one written from the choices; text
  // once somebody has edited it, which the chips then leave alone.
  const [edited, setEdited] = useState<string | null>(null);
  const persona = edited ?? written;

  const valid = name.trim().length > 0;
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);
  // The example name, where the field is still empty.
  const shown = name.trim() || t("Support", { context: "agent", defaultValue: "Support" });

  const toggle = (id: string) =>
    setJobs((prev) => (prev.includes(id) ? prev.filter((j) => j !== id) : [...prev, id]));

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid) return;
    onSubmit({
      assistantName: name.trim(),
      assistantAvatar: avatar,
      assistantJobs: jobs,
      persona: persona.trim() || written,
    });
  }

  return (
    <form
      id={formId}
      onSubmit={handleSubmit}
      className="flex flex-col divide-y divide-hairline [&>*]:py-5 [&>*:first-child]:pt-0 [&>*:last-child]:mt-1 [&>*:last-child]:border-t-0 [&>*:last-child]:py-3.5"
    >
      <div className="space-y-1.5">
        <Label htmlFor="assistant-name">{t("Name")}</Label>
        <Input
          id="assistant-name"
          className="h-9 max-w-[360px]"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            onNameChange?.(e.target.value);
          }}
          maxLength={60}
          placeholder={t("Support", { context: "agent", defaultValue: "Support" })}
          autoFocus
        />
        <p className="m-0 text-meta text-muted-foreground">
          {t("Short works best. The team will say “ask {{name}}”.", { name: shown })}
        </p>
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium" id="face-label">
          {t("Face")}
        </span>
        <AgentMarkPicker value={avatar} onChange={setAvatar} size={56} />
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium" id="job-label">
          {t("What should it do?")}
        </span>
        <div aria-labelledby="job-label" className="flex flex-wrap gap-2">
          {JOBS.map((job) => {
            const on = jobs.includes(job.id);
            return (
              <button
                key={job.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(job.id)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-meta font-medium",
                  on
                    ? "border-foreground bg-foreground text-background"
                    : "border-input bg-card text-foreground hover:bg-surface-muted",
                )}
              >
                {on ? <Check className="size-3.5" aria-hidden /> : null}
                {lookup(t, job.label)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="assistant-persona">{t("Persona")}</Label>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEdited(null)}>
            {t("Rewrite")}
          </Button>
        </div>
        <Textarea
          id="assistant-persona"
          rows={4}
          value={persona}
          onChange={(e) => setEdited(e.target.value)}
        />
        <p className="m-0 text-meta text-muted-foreground">
          {t(
            "Written from your choices. Edit it freely; this is what the agent reads before every thread.",
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-sidebar px-4 py-3.5">
        <span className="text-meta whitespace-nowrap text-muted-foreground">
          {t("In the sidebar")}
        </span>
        <span className="inline-flex h-8 items-center gap-2.5 rounded-md bg-sidebar-accent px-2.5 text-sm font-medium">
          <AgentMark agent={{ name: shown, avatar }} size={24} />
          {shown}
        </span>
        <span className="ml-auto text-meta text-muted-foreground">
          {t("Only you can use it until you share it.")}
        </span>
      </div>
    </form>
  );
}

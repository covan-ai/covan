import { toast } from "sonner";
import { MessageSquare } from "lucide-react";
import type { SlackState } from "@/lib/connections-api";
import type { Agent } from "@/lib/agents-store";
import { Button } from "@/components/ui/button";
import { Chip, SectionCard } from "@/components/section-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRemoveSlack, useSetSlackAgent, useStartSlackInstall } from "@/hooks/use-connections";

/**
 * Slack, which is a surface rather than a source.
 *
 * Everything else on this page brings documents in. This sends the product out:
 * mention the app in a thread and the agent answers there, with the same
 * retrieval the chat screen uses. So it gets its own section rather than a row
 * among the connections — the only thing they share is a consent screen.
 */
export function SlackCard({ state, agents }: { state: SlackState; agents: Agent[] }) {
  const install = useStartSlackInstall();
  const setAgent = useSetSlackAgent();
  const remove = useRemoveSlack();

  if (!state.configured) {
    return (
      <SectionCard className="flex flex-col gap-4 opacity-70">
        <SlackHeading chip={<Chip tone="neutral">Not configured</Chip>} />
        <p className="text-[13px] leading-[1.45] text-muted-foreground">
          Not configured on this deployment. An operator registers a Slack app and sets{" "}
          <span className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-xs">
            SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET
          </span>{" "}
          to turn it on.
        </p>
      </SectionCard>
    );
  }

  if (!state.installation) {
    return (
      <SectionCard className="flex flex-col gap-4">
        <SlackHeading chip={<Chip tone="neutral">Not installed</Chip>} />
        <p className="text-[13px] leading-[1.45] text-muted-foreground">
          Ask the agent from a channel by mentioning it, or send it a direct message. Whoever asks
          is answered as themselves — their Slack email has to match a member of this workspace.
        </p>
        <div>
          <Button
            disabled={install.isPending}
            onClick={() =>
              install.mutate(undefined, {
                onError: (err) =>
                  toast.error(err instanceof Error ? err.message : "Could not start the install"),
              })
            }
          >
            {install.isPending ? "Opening…" : "Add to Slack"}
          </Button>
        </div>
      </SectionCard>
    );
  }

  const { installation } = state;

  return (
    <SectionCard className="flex flex-col gap-4">
      <SlackHeading
        subtitle={installation.teamName}
        chip={
          <Chip tone={installation.agentId ? "on" : "neutral"}>
            {installation.agentId ? "Installed" : "Needs an agent"}
          </Chip>
        }
      />

      {installation.agentId ? null : (
        <p className="rounded-lg border border-hairline bg-background px-4 py-3 text-[13px] leading-[1.45] text-muted-foreground">
          The agent this was pointing at is gone, so the app answers every question by saying so.
          Choose another one.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={installation.agentId ?? ""}
          onValueChange={(agentId) =>
            setAgent.mutate(agentId, {
              onSuccess: () => toast.success("Slack will ask that agent from now on."),
              onError: (err) =>
                toast.error(err instanceof Error ? err.message : "Could not change the agent"),
            })
          }
        >
          <SelectTrigger className="h-9 w-[220px] text-sm">
            <SelectValue placeholder="Which agent answers?" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.emoji ? `${agent.emoji} ` : ""}
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          disabled={remove.isPending}
          onClick={() => {
            if (
              !window.confirm(
                `Disconnect Slack from ${installation.teamName}?\n\n` +
                  "The conversations it created stay in Covan. Remove the app from Slack itself " +
                  "to revoke its access there.",
              )
            ) {
              return;
            }
            remove.mutate(undefined, {
              onSuccess: () => toast.success("Slack disconnected."),
              onError: (err) =>
                toast.error(err instanceof Error ? err.message : "Could not disconnect"),
            });
          }}
        >
          Disconnect
        </Button>
      </div>
    </SectionCard>
  );
}

function SlackHeading({ subtitle, chip }: { subtitle?: string; chip: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline">
          <MessageSquare className="h-[22px] w-[22px]" />
        </span>
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className="font-dm text-[18px] font-medium leading-tight">Slack</span>
          <span className="text-[13px] leading-tight text-muted-foreground">
            {subtitle ?? "Ask an agent from a channel, without leaving Slack."}
          </span>
        </span>
      </div>
      {chip}
    </div>
  );
}

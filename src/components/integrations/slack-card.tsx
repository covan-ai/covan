import { useState } from "react";
import { toast } from "sonner";
import { SlackMark } from "./brand-marks";
import type { SlackState } from "@/lib/connections-api";
import type { Agent } from "@/lib/agents-store";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/chip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRemoveSlack, useSetSlackAgent, useStartSlackInstall } from "@/hooks/use-connections";
import { AppLogo } from "./app-logo";
import { IntegrationCard, IntegrationRow } from "./integration-row";

/**
 * Slack, installed (A8): a row in Connected — which workspace, which agent
 * answers, who installed it — and Manage for the agent, a reconnect when the
 * install predates a scope, and Disconnect.
 *
 * Slack answers as whoever asked, so an agent shared with a few people
 * answers a few people; the dialog says so where the agent is chosen.
 */
export function SlackRow({
  installation,
  agents,
  installedBy,
}: {
  installation: NonNullable<SlackState["installation"]>;
  agents: Agent[];
  installedBy?: string | null;
}) {
  const [managing, setManaging] = useState(false);
  const install = useStartSlackInstall();
  const setAgent = useSetSlackAgent();
  const remove = useRemoveSlack();
  const agent = agents.find((a) => a.id === installation.agentId);
  const missing = (installation.missingScopes?.length ?? 0) > 0;

  const reinstall = () =>
    install.mutate(undefined, {
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Could not start the install"),
    });

  return (
    <>
      <IntegrationRow
        logo={<AppLogo mark={SlackMark} name="Slack" size={36} />}
        name="Slack"
        description={[
          installation.teamName,
          agent ? `${agent.name} answers mentions and messages` : "no agent answers yet",
          installedBy ? `installed by ${installedBy}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        status={
          !installation.agentId
            ? { state: "waiting", text: "Needs an agent" }
            : missing
              ? { state: "waiting", text: "Needs a reconnect" }
              : { state: "done", text: "Working" }
        }
        action={
          <Button size="sm" variant="secondary" onClick={() => setManaging(true)}>
            Manage
          </Button>
        }
      />

      <Dialog open={managing} onOpenChange={setManaging}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Slack · {installation.teamName}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {installation.agentId ? null : (
              <p className="m-0 rounded-lg border border-hairline px-4 py-3 text-meta leading-[1.45] text-muted-foreground">
                The agent this was pointing at is gone, so the app answers every question by saying
                so. Choose another one.
              </p>
            )}

            {/* Slack grants scopes per install, so one made before routines
                could listen to channels keeps answering mentions and hears
                nothing else until it is installed again. */}
            {missing ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-hairline px-4 py-3">
                <p className="m-0 min-w-0 flex-1 text-meta leading-[1.45] text-muted-foreground">
                  Routines can't start on channel messages or reactions yet. This install was made
                  before Covan asked to hear them — reconnect to allow it.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={install.isPending}
                  onClick={reinstall}
                >
                  {install.isPending ? "Opening…" : "Reconnect"}
                </Button>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label>Which agent answers</Label>
              <Select
                value={installation.agentId ?? ""}
                onValueChange={(agentId) =>
                  setAgent.mutate(agentId, {
                    onSuccess: () => toast.success("Slack will ask that agent from now on."),
                    onError: (err) =>
                      toast.error(
                        err instanceof Error ? err.message : "Could not change the agent",
                      ),
                  })
                }
              >
                <SelectTrigger aria-label="Which agent answers">
                  <SelectValue placeholder="Choose an agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {installation.agentId ? (
                <p className="m-0 text-meta leading-[1.45] text-muted-foreground">
                  Anyone the agent isn't shared with gets a polite no in Slack instead of an answer.
                </p>
              ) : null}
            </div>

            <div className="border-t border-hairline pt-3">
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
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
                    onSuccess: () => {
                      setManaging(false);
                      toast.success("Slack disconnected.");
                    },
                    onError: (err) =>
                      toast.error(err instanceof Error ? err.message : "Could not disconnect"),
                  });
                }}
              >
                Disconnect
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Slack, not installed, in the Available grid. Unconfigured, it names the
 * variables that would turn it on rather than hiding.
 */
export function SlackCard({ state }: { state: SlackState }) {
  const install = useStartSlackInstall();
  if (state.installation) return null;

  return (
    <IntegrationCard
      logo={<AppLogo mark={SlackMark} name="Slack" size={28} />}
      name="Slack"
      note={state.configured ? null : <Chip size="sm">Not configured</Chip>}
      description={
        state.configured ? (
          "Mention an agent in a channel or message it. Whoever asks is answered as themselves."
        ) : (
          <>
            An operator registers a Slack app and sets{" "}
            <span className="font-mono text-xs">
              SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET
            </span>{" "}
            to turn it on.
          </>
        )
      }
      action={
        state.configured ? (
          <Button
            size="sm"
            variant="secondary"
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
        ) : undefined
      }
    />
  );
}

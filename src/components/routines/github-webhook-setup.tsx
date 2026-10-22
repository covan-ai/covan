import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RevealedSecret } from "@/components/revealed-secret";
import { useRoutineEventSetup } from "@/hooks/use-routines";

/** What GitHub calls each event in "Let me select individual events". */
const GITHUB_EVENT_NAME: Record<string, string> = {
  "github.push": "Pushes",
  "github.pull_request": "Pull requests",
  "github.issues": "Issues",
};

/**
 * The steps, URL and secret for a GitHub webhook, on an event routine's page.
 *
 * GitHub events arrive through a webhook the owner adds to their repository
 * themselves — there is no GitHub App to install — so this is the whole of
 * the setup, and it stays on the page rather than being shown once: a person
 * adding the same routine to a second repository needs it again. The secret
 * waits behind a button so it is not on screen for whoever is looking over a
 * shoulder.
 */
export function GitHubWebhookSetup({
  routineId,
  eventType,
}: {
  routineId: string;
  eventType: string;
}) {
  const { data, isPending, isError } = useRoutineEventSetup(routineId, true);
  const [showSecret, setShowSecret] = useState(false);

  if (isPending) return <p className="text-meta text-muted-foreground">Loading the webhook…</p>;
  if (isError) {
    return (
      <p className="text-meta text-muted-foreground">
        Couldn't load the webhook. Reload to try again.
      </p>
    );
  }
  if (data.kind !== "github") return null;

  const eventName = GITHUB_EVENT_NAME[eventType] ?? "the matching event";

  return (
    <div className="space-y-3 rounded-lg border border-hairline p-4">
      <p className="text-sm">Add this webhook to your repository</p>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        <li>On GitHub, open the repository's Settings → Webhooks → Add webhook.</li>
        <li>
          Paste the payload URL and the secret below, and set the content type to{" "}
          <code className="font-mono">{data.contentType}</code>.
        </li>
        <li>
          Under “Which events”, choose “Let me select individual events”, tick {eventName}, and
          save.
        </li>
      </ol>
      <div className="space-y-1.5">
        <p className="text-meta text-muted-foreground">Payload URL</p>
        <RevealedSecret value={data.url} label="Copy payload URL" />
      </div>
      <div className="space-y-1.5">
        <p className="text-meta text-muted-foreground">Secret</p>
        {showSecret ? (
          <RevealedSecret value={data.secret} label="Copy secret" />
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setShowSecret(true)}>
            Show secret
          </Button>
        )}
      </div>
      <p className="text-meta text-muted-foreground">
        The same webhook can be added to more than one repository. Choosing a different event later
        makes a new URL and secret.
      </p>
    </div>
  );
}

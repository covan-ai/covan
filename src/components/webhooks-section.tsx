import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DocsLink } from "@/components/docs-link";
import { Field } from "@/components/field";
import { RevealedSecret } from "@/components/revealed-secret";
import { SectionLabel } from "@/components/section";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  api,
  ApiError,
  WEBHOOK_EVENTS,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEvent,
} from "@/lib/api-client";
import type { DotState } from "@/lib/dot-states";
import { clockTime } from "@/lib/day-groups";
import { useWorkspaceRole } from "@/lib/workspace-role";

/** What each event means, beside its name (A26). */
const EVENT_WORDS: Record<WebhookEvent, string> = {
  "thread.finished": "an agent has an answer",
  "agent.needs_you": "a question or an approval is waiting",
  "routine.failed": "a shared routine's run failed",
  "document.created": "a file was added to a workspace folder",
};

const KEY = ["webhooks"];

/**
 * Settings › API keys › Webhooks (A26): where the workspace's events are
 * POSTed, which ones, the secret that signs them, and the last day of
 * deliveries with a Resend on the ones that gave up.
 *
 * An admin's. The secret is shown once — when the endpoint is made or the
 * secret rotated — and never read back, so the screen holds it in state until
 * "I have saved it" and nowhere else.
 */
export function WebhooksSection() {
  const { me, isAdmin } = useWorkspaceRole();
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: api.webhooks.list,
    enabled: !!me && isAdmin,
  });
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ endpointId: string; value: string } | null>(null);

  const heading = (
    <SectionLabel action={<span className="font-normal">Signed with a secret you keep</span>}>
      Webhooks
    </SectionLabel>
  );

  if (!me) return heading;
  if (!isAdmin) {
    return (
      <>
        {heading}
        <p className="text-sm text-muted-foreground">
          Owners and admins set up webhooks for the workspace.
        </p>
      </>
    );
  }
  if (!data) return heading;

  const deliveriesOf = (id: string) => data.deliveries.filter((d) => d.endpointId === id);

  return (
    <>
      {heading}
      {data.endpoints.map((e, i) => (
        <div key={e.id} className={i > 0 ? "mt-6 border-t border-hairline pt-1" : undefined}>
          <EndpointFields
            endpoint={e}
            deliveries={deliveriesOf(e.id)}
            secret={secret?.endpointId === e.id ? secret.value : null}
            onSecret={(value) => setSecret(value ? { endpointId: e.id, value } : null)}
          />
        </div>
      ))}
      {data.endpoints.length === 0 || adding ? (
        <NewEndpoint
          onCancel={data.endpoints.length > 0 ? () => setAdding(false) : undefined}
          onCreated={(endpoint) => {
            setAdding(false);
            setSecret({ endpointId: endpoint.id, value: endpoint.secret });
          }}
        />
      ) : (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAdding(true)}>
          Add another endpoint
        </Button>
      )}
    </>
  );
}

function EventChecks({
  value,
  onChange,
  disabled,
}: {
  value: WebhookEvent[];
  onChange: (next: WebhookEvent[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {WEBHOOK_EVENTS.map((ev) => (
        <label key={ev} className="flex items-center gap-2.5 text-sm">
          <Checkbox
            checked={value.includes(ev)}
            disabled={disabled}
            onCheckedChange={(on) => onChange(on ? [...value, ev] : value.filter((x) => x !== ev))}
          />
          <span className="font-mono text-meta">{ev}</span>
          <span className="text-meta text-muted-foreground">{EVENT_WORDS[ev]}</span>
        </label>
      ))}
    </div>
  );
}

const ENDPOINT_HELP =
  "We POST JSON here. Retried three times over an hour, then listed below as failed.";

function NewEndpoint({
  onCancel,
  onCreated,
}: {
  onCancel?: () => void;
  onCreated: (endpoint: WebhookEndpoint & { secret: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["thread.finished", "agent.needs_you"]);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!url.trim() || saving) return;
    setSaving(true);
    try {
      const endpoint = await api.webhooks.create({ url: url.trim(), events });
      await queryClient.invalidateQueries({ queryKey: KEY });
      onCreated(endpoint);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't add that endpoint");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Field label="Endpoint" help={ENDPOINT_HELP} htmlFor="webhook-new-url">
        <Input
          id="webhook-new-url"
          type="url"
          className="max-w-[480px]"
          placeholder="https://hooks.example.com/covan"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
        />
      </Field>
      <Field label="Events" help="Only what you tick.">
        <EventChecks value={events} onChange={setEvents} />
      </Field>
      <Field label="" className="py-4">
        <div className="flex items-center gap-2">
          <Button onClick={() => void create()} disabled={saving || !url.trim()}>
            {saving ? "Adding…" : "Add endpoint"}
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </Field>
    </>
  );
}

function EndpointFields({
  endpoint,
  deliveries,
  secret,
  onSecret,
}: {
  endpoint: WebhookEndpoint;
  deliveries: WebhookDelivery[];
  secret: string | null;
  onSecret: (value: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "remove" | null>(null);
  const shownUrl = url ?? endpoint.url;
  const id = `webhook-url-${endpoint.id}`;

  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: KEY });
      if (done) toast.success(done);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save that");
    } finally {
      setBusy(null);
    }
  };

  const saveUrl = () => {
    const next = shownUrl.trim();
    if (!next || next === endpoint.url) return setUrl(null);
    void run("url", () => api.webhooks.update(endpoint.id, { url: next }), "Endpoint saved").then(
      () => setUrl(null),
    );
  };

  const test = () =>
    run("test", async () => {
      const r = await api.webhooks.test(endpoint.id);
      if (r.status === "ok") {
        toast.success(`Test delivered · ${r.statusCode ?? 200}${ms(r.latencyMs)}`);
      } else {
        toast.error(`Test not delivered${r.statusCode ? ` · ${r.statusCode}` : ""}`, {
          description: r.error ?? undefined,
        });
      }
    });

  return (
    <>
      <Field label="Endpoint" help={ENDPOINT_HELP} htmlFor={id}>
        <Input
          id={id}
          type="url"
          className="max-w-[480px]"
          value={shownUrl}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={saveUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveUrl();
            if (e.key === "Escape") setUrl(null);
          }}
        />
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => void test()} disabled={!!busy}>
            {busy === "test" ? "Sending…" : "Send a test"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!!busy}
            onClick={() =>
              void run(
                "enabled",
                () => api.webhooks.update(endpoint.id, { enabled: !endpoint.enabled }),
                endpoint.enabled ? "Endpoint turned off" : "Endpoint turned on",
              )
            }
          >
            {endpoint.enabled ? "Turn off" : "Turn on"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={!!busy}
            onClick={() => setConfirm("remove")}
          >
            Remove
          </Button>
          {!endpoint.enabled && (
            <span className="ml-1 inline-flex items-center gap-1.5 text-meta text-muted-foreground">
              <StatusDot state="idle" /> Off — events are listed as not sent
            </span>
          )}
        </div>
      </Field>

      <Field label="Events" help="Only what you tick.">
        <EventChecks
          value={endpoint.events}
          disabled={busy === "events"}
          onChange={(events) =>
            void run("events", () => api.webhooks.update(endpoint.id, { events }))
          }
        />
      </Field>

      <Field
        label="Signing secret"
        help="Verify the signature header with it. Shown once when made; rotate to get a new one."
      >
        {secret ? (
          <div className="max-w-[560px] rounded-xl border border-foreground p-4">
            <div className="mb-2.5 flex items-center gap-2 text-sm font-medium">
              <StatusDot state="waiting" /> Copy it now; it is not shown again.
            </div>
            <RevealedSecret value={secret} label="Copy signing secret" inline>
              <Button variant="ghost" size="sm" onClick={() => onSecret(null)}>
                I have saved it
              </Button>
            </RevealedSecret>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-input bg-surface-muted px-2.5 py-1.5 font-mono text-meta">
              whsec_••••••••••••••••••••
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={!!busy}
              onClick={() => setConfirm("rotate")}
            >
              Rotate
            </Button>
            <DocsLink page="api" section="webhooks">
              How to verify
            </DocsLink>
          </div>
        )}
      </Field>

      <Field label="Recent deliveries" help="Last 24 hours.">
        {deliveries.length === 0 ? (
          <p className="pt-1 text-sm text-muted-foreground">Nothing sent in the last day.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {deliveries.map((d) => (
              <DeliveryRow
                key={d.id}
                delivery={d}
                busy={busy === d.id}
                onResend={() =>
                  void run(d.id, () => api.webhooks.resend(d.id), "Sent again from the first try")
                }
              />
            ))}
          </ul>
        )}
      </Field>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "rotate" ? "Rotate the signing secret?" : "Remove this endpoint?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "rotate"
                ? "The old secret stops working at once, so update your receiver in the same sitting. The new one is shown once."
                : `Nothing more is sent to ${hostOf(endpoint.url)}. Deliveries already listed stay for a day.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm === "remove" ? "danger" : "default"}
              onClick={() =>
                confirm === "rotate"
                  ? void run("rotate", async () => {
                      const r = await api.webhooks.rotate(endpoint.id);
                      onSecret(r.secret);
                    })
                  : void run("remove", () => api.webhooks.remove(endpoint.id), "Endpoint removed")
              }
            >
              {confirm === "rotate" ? "Rotate" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const ms = (latency: number | null | undefined) => (latency != null ? ` · ${latency} ms` : "");

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "this address";
  }
}

const DOT: Record<WebhookDelivery["status"], DotState> = {
  ok: "done",
  failed: "failed",
  pending: "idle",
  dropped: "idle",
};

/** "· 200 · 84 ms", "· 503 after 4 tries", "· trying again", "· not sent, the endpoint is off". */
function outcomeWords(d: WebhookDelivery): string {
  const tries = `${d.attempt} ${d.attempt === 1 ? "try" : "tries"}`;
  switch (d.status) {
    case "ok":
      return ` · ${d.statusCode ?? 200}${ms(d.latencyMs)}`;
    case "failed":
      return ` · ${d.statusCode ?? d.error ?? "no answer"} after ${tries}`;
    case "pending":
      return d.attempt > 0 ? ` · trying again after ${tries}` : " · sending";
    case "dropped":
      return " · not sent, the endpoint is off";
  }
}

function DeliveryRow({
  delivery,
  busy,
  onResend,
}: {
  delivery: WebhookDelivery;
  busy: boolean;
  onResend: () => void;
}) {
  return (
    <li className="flex min-h-11 items-center gap-3 border-b border-hairline text-sm last:border-b-0">
      <StatusDot state={DOT[delivery.status]} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-mono text-meta">{delivery.event}</span>
        <span className="text-muted-foreground">{outcomeWords(delivery)}</span>
      </span>
      <span className="text-meta text-muted-foreground tabular-nums">
        {clockTime(delivery.createdAt)}
      </span>
      {(delivery.status === "failed" || delivery.status === "dropped") && (
        <Button variant="ghost" size="sm" onClick={onResend} disabled={busy}>
          {busy ? "Sending…" : "Resend"}
        </Button>
      )}
    </li>
  );
}

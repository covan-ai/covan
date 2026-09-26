import { useState } from "react";
import { Link, Mail, Plus, RefreshCw, Send, Trash2, Webhook } from "lucide-react";
import { SectionCard } from "@/components/section-card";
import { SectionHeading } from "@/components/page-container";
import { RevealedSecret } from "@/components/revealed-secret";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import type { DeliveryChannel, DeliveryChannelKind } from "@/lib/routines-api";
import {
  useDeliveryChannels,
  useCreateChannel,
  useDeleteChannel,
  useTestChannel,
  useRotateChannelSecret,
} from "@/hooks/use-routines";

const KIND_LABEL: Record<DeliveryChannelKind, string> = {
  email: "Email",
  slack_webhook: "Slack webhook",
  webhook: "Webhook",
};

/**
 * Row actions are visible at once on a touch screen and revealed on hover or
 * focus from `sm` up.
 *
 * The delete button used to be `opacity-0 group-hover:opacity-100` and nothing
 * else, which is DESIGN.md's fifth failure mode exactly: unreachable by
 * keyboard, and invisible on a phone where there is no hover at all. Two more
 * actions were about to be added beside it, so it is closed here rather than
 * tripled.
 */
const ROW_ACTION =
  "shrink-0 rounded-md p-1 text-muted-foreground transition-opacity " +
  "hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring sm:opacity-0 sm:group-hover:opacity-100";

function ChannelIcon({ kind }: { kind: DeliveryChannelKind }) {
  const className = "h-4 w-4 shrink-0 text-muted-foreground";
  if (kind === "email") return <Mail className={className} />;
  if (kind === "webhook") return <Webhook className={className} />;
  return <Link className={className} />;
}

export function DeliveryChannelsCard() {
  const { data: channels = [], isLoading } = useDeliveryChannels();
  const createChannel = useCreateChannel();
  const deleteChannel = useDeleteChannel();
  const testChannel = useTestChannel();
  const rotateSecret = useRotateChannelSecret();

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DeliveryChannelKind>("email");
  const [secret, setSecret] = useState("");

  /**
   * The signing secret, for as long as it is on screen. Held here rather than
   * fetched, because there is no endpoint that would answer: this is the only
   * moment it exists outside the database.
   */
  const [revealed, setRevealed] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setKind("email");
    setSecret("");
    setRevealed(null);
  };

  const submit = async () => {
    try {
      const created = await createChannel.mutateAsync({ kind, secret: secret.trim() });
      if (created.signingSecret) {
        // Not closed, and no toast: the dialog becomes the one place this
        // string is ever shown, and closing over it would lose it for good.
        setRevealed(created.signingSecret);
        return;
      }
      toast.success("Delivery channel added");
      close();
    } catch (err) {
      // The API owns validation (a Slack URL must be on hooks.slack.com, an
      // address must look like one, a webhook URL must not point into private
      // space), so its message is the useful one.
      toast.error(err instanceof ApiError ? err.message : "Could not add that channel");
    }
  };

  const sendTest = async (channel: DeliveryChannel) => {
    try {
      await testChannel.mutateAsync(channel.id);
      toast.success(`Test sent to ${channel.label}`);
    } catch (err) {
      // 502 carries what the receiver itself said. Replacing that with
      // "delivery failed" would make the button worth less than not having it.
      toast.error(err instanceof ApiError ? err.message : "Could not send a test");
    }
  };

  const rotate = async (channel: DeliveryChannel) => {
    try {
      const { signingSecret } = await rotateSecret.mutateAsync(channel.id);
      setRevealed(signingSecret);
      setOpen(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not rotate that secret");
    }
  };

  const removeChannel = async (id: string) => {
    try {
      await deleteChannel.mutateAsync(id);
      toast.success("Delivery channel removed");
    } catch (err) {
      // 409 is the deferred foreign key on routines.delivery_channel_id. The
      // raw error says nothing a user can act on; naming the cause does.
      if (err instanceof ApiError && err.status === 409) {
        toast.error("This channel is still used by a routine.");
        return;
      }
      toast.error(err instanceof ApiError ? err.message : "Could not remove that channel");
    }
  };

  return (
    <section className="mt-10">
      <SectionHeading
        title="Delivery channels"
        description="Where your routines send their updates."
        action={
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Add channel
          </Button>
        }
      />

      <SectionCard padded={false} className="mt-3 overflow-hidden">
        {isLoading ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">Loading…</p>
        ) : channels.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            No delivery channels yet. Add one to send routine updates to Slack, an inbox, or
            anything that can take a webhook.
          </p>
        ) : (
          <ul className="divide-y divide-hairline">
            {channels.map((channel) => (
              <li
                key={channel.id}
                className="group flex items-center gap-3 px-5 py-3.5 transition-colors duration-200 hover:bg-surface-hover"
              >
                <ChannelIcon kind={channel.kind} />
                <span className="min-w-0 flex-1 truncate text-sm">{channel.label}</span>

                <button
                  onClick={() => void sendTest(channel)}
                  disabled={testChannel.isPending}
                  aria-label={`Send a test to ${channel.label}`}
                  title="Send a test"
                  className={ROW_ACTION}
                >
                  <Send className="h-4 w-4" />
                </button>

                {channel.kind === "webhook" && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <button
                        aria-label={`Rotate the signing secret for ${channel.label}`}
                        title="Rotate signing secret"
                        className={ROW_ACTION}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Rotate this signing secret?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Deliveries are signed with the new secret from the next one onwards, and
                          the old secret stops working the moment you confirm. A receiver still
                          checking against the old one will reject everything until you update it.
                          The destination URL does not change.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void rotate(channel)}>
                          Rotate
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}

                <button
                  onClick={() => void removeChannel(channel.id)}
                  aria-label={`Remove ${channel.label}`}
                  title="Remove"
                  className={`${ROW_ACTION} hover:text-destructive`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{revealed ? "Your signing secret" : "Add a delivery channel"}</DialogTitle>
          </DialogHeader>

          {revealed ? (
            <div className="space-y-4">
              <RevealedSecret value={revealed} label="Copy signing secret" />
              <p className="text-xs text-muted-foreground">
                This is the only time it is shown. Give it to whatever receives the webhook: every
                delivery carries an <code className="font-mono">X-Covan-Signature</code> header
                computed with it, and a receiver that does not check the signature will accept a
                body from anybody. Lost it? Rotate for a new one.
              </p>
              <div className="flex justify-end">
                <Button variant="ghost" onClick={close}>
                  I've saved it
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="channel-kind">Type</Label>
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    setKind(v as DeliveryChannelKind);
                    // The old value is almost never valid for the new kind, and
                    // a left-behind address under "Webhook" reads as accepted.
                    setSecret("");
                  }}
                >
                  <SelectTrigger id="channel-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">{KIND_LABEL.email}</SelectItem>
                    <SelectItem value="slack_webhook">{KIND_LABEL.slack_webhook}</SelectItem>
                    <SelectItem value="webhook">{KIND_LABEL.webhook}</SelectItem>
                  </SelectContent>
                </Select>
                {kind === "webhook" && (
                  <p className="text-xs text-muted-foreground">
                    A signed POST to any endpoint you run.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="channel-secret">
                  {kind === "email" ? "Email address" : "Webhook URL"}
                </Label>
                <Input
                  id="channel-secret"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={
                    kind === "email"
                      ? "you@company.com"
                      : kind === "slack_webhook"
                        ? "https://hooks.slack.com/services/…"
                        : "https://example.com/hooks/covan"
                  }
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void submit()}
                  disabled={!secret.trim() || createChannel.isPending}
                >
                  {createChannel.isPending ? "Adding…" : "Add channel"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

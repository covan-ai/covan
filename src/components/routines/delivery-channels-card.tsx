import { useState } from "react";
import { Link, Mail, Plus, Trash2 } from "lucide-react";
import { SectionCard } from "@/components/section-card";
import { SectionHeading } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import { useDeliveryChannels, useCreateChannel, useDeleteChannel } from "@/hooks/use-routines";

type Kind = "slack_webhook" | "email";

export function DeliveryChannelsCard() {
  const { data: channels = [], isLoading } = useDeliveryChannels();
  const createChannel = useCreateChannel();
  const deleteChannel = useDeleteChannel();

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("email");
  const [secret, setSecret] = useState("");

  const close = () => {
    setOpen(false);
    setKind("email");
    setSecret("");
  };

  const submit = async () => {
    try {
      await createChannel.mutateAsync({ kind, secret: secret.trim() });
      toast.success("Delivery channel added");
      close();
    } catch (err) {
      // The API owns validation (a Slack URL must be on hooks.slack.com, an
      // address must look like one), so its message is the useful one.
      toast.error(err instanceof ApiError ? err.message : "Could not add that channel");
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
            No delivery channels yet. Add one to start sending routine updates to Slack or email.
          </p>
        ) : (
          <ul className="divide-y divide-hairline">
            {channels.map((channel) => (
              <li
                key={channel.id}
                className="group flex items-center gap-3 px-5 py-3.5 transition-colors duration-200 hover:bg-surface-hover"
              >
                {channel.kind === "email" ? (
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Link className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{channel.label}</span>
                <button
                  onClick={() => void removeChannel(channel.id)}
                  aria-label={`Remove ${channel.label}`}
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
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
            <DialogTitle>Add a delivery channel</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="channel-kind">Type</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
                <SelectTrigger id="channel-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="slack_webhook">Slack webhook</SelectItem>
                </SelectContent>
              </Select>
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
                  kind === "email" ? "you@company.com" : "https://hooks.slack.com/services/…"
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
        </DialogContent>
      </Dialog>
    </section>
  );
}

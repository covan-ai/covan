import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError } from "@/lib/api-client";
import { ROLE_SUMMARY, WORKSPACE_ROLES, type WorkspaceRole } from "@/lib/roles";
import { toast } from "sonner";

export function InviteMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setEmail("");
    setRole("member");
  };

  const submit = async () => {
    if (!email.trim() || saving) return;
    setSaving(true);
    try {
      const invite = await api.invitations.create({ email: email.trim(), role });
      await queryClient.invalidateQueries({ queryKey: ["invitations"] });
      // This used to say "Invite sent" whether or not anything had been sent —
      // for most of the product's life, nothing ever was. The invitation is the
      // row either way; what changes is whether the person on the other end has
      // any way of knowing about it, so say which happened.
      toast.success(
        invite.emailed
          ? `Invite emailed to ${invite.email}`
          : `${invite.email} is invited — let them know, and it will be waiting when they sign in`,
      );
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't send invite");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">Invite teammate</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs" htmlFor="invite-email">
              Email
            </Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as WorkspaceRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* One line each, because "viewer" is not self-explanatory and
                    the difference between the three is the whole reason to
                    choose. ROLE_SUMMARY is what the policies actually do. */}
                {WORKSPACE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    <span className="capitalize">{r}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{ROLE_SUMMARY[r]}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button onClick={submit} disabled={saving || !email.trim()}>
            {saving ? "Sending…" : "Send invite"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

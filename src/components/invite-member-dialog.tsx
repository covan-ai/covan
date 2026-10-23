import { useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { toast } from "sonner";
import { lookup, msg, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { Chip } from "@/components/chip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError } from "@/lib/api-client";
import { ROLE_WORD, WORKSPACE_ROLES, type WorkspaceRole } from "@/lib/roles";
import { invitationNotice } from "@/lib/invitation-notice";
import { copyInviteText } from "@/lib/invite-text";

/** Something that reads as an address; the server has the last word. */
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** What the link's toast says, by the role the link joins as. */
const LINK_COPIED: Record<"member" | "viewer", string> = {
  member: msg(
    "Link copied. It works for 7 days and joins as a member; turn it off in Team › Invitations.",
  ),
  viewer: msg(
    "Link copied. It works for 7 days and joins as a viewer; turn it off in Team › Invitations.",
  ),
};

/**
 * "Invite to Acme" (A25): the addresses as chips, the role, what they can
 * use, one sentence on what the roles mean — or a link that works for seven
 * days, for a team that would rather paste one link into its own chat.
 *
 * Each address is its own invitation, sent one after another, so the daily
 * cap and the refusals are the server's as they always were.
 */
export function InviteMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(false);

  const reset = () => {
    setEmails([]);
    setDraft("");
    setRole("member");
  };

  /** The typed address becomes a chip, if it is one. */
  const commit = () => {
    const parts = draft
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const good = parts.filter(looksLikeEmail);
    setEmails((prev) => [...prev, ...good.filter((e) => !prev.includes(e))]);
    setDraft(parts.filter((p) => !looksLikeEmail(p)).join(" "));
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      if (draft.trim()) {
        e.preventDefault();
        commit();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    }
    if (e.key === "Backspace" && draft === "" && emails.length > 0) {
      setEmails(emails.slice(0, -1));
    }
  };

  const all = [...emails, ...draft.split(/[\s,;]+/).filter(looksLikeEmail)];

  const submit = async () => {
    if (all.length === 0 || saving) return;
    setSaving(true);
    const invited: string[] = [];
    const failed: { email: string; reason: string }[] = [];
    const unsent: { email: string; url: string }[] = [];
    let emailed = 0;
    for (const email of all) {
      try {
        const invite = await api.invitations.create({ email, role });
        invited.push(invite.email);
        if (invite.emailed) emailed += 1;
        else if (invite.inviteUrl) unsent.push({ email: invite.email, url: invite.inviteUrl });
      } catch (e) {
        failed.push({ email, reason: e instanceof ApiError ? e.message : t("Couldn't invite") });
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["invitations"] });
    setSaving(false);
    if (invited.length > 0) {
      // Whether anybody can know about it: the invitation is the row either
      // way, so say whether mail went out — and when it did not, hand over the
      // links, which exist only in these responses.
      const notice = invitationNotice(
        { invited, emailed, failed: failed.map((f) => f.email) },
        t,
        locale,
      );
      toast[notice.tone](
        notice.message,
        unsent.length > 0
          ? {
              duration: 12000,
              action: { label: t("Copy invite text"), onClick: () => copyInviteText(unsent, t) },
            }
          : undefined,
      );
    }
    for (const f of failed) {
      const refusal = `${f.email}: ${f.reason}`;
      toast.error(refusal);
    }
    if (failed.length === 0) {
      reset();
      onOpenChange(false);
    } else {
      setEmails(failed.map((f) => f.email));
      setDraft("");
    }
  };

  // A link joins as a member or a viewer, never an admin (0129).
  const linkRole = role === "viewer" ? "viewer" : "member";
  const copyLink = async () => {
    if (linking) return;
    setLinking(true);
    try {
      const link = await api.inviteLinks.create(linkRole);
      await navigator.clipboard.writeText(link.url);
      toast.success(lookup(t, LINK_COPIED[linkRole]));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("Couldn't make a link"));
    } finally {
      setLinking(false);
    }
  };

  const theWorkspace = t("the workspace");

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {t("Invite to {{name}}", { name: me?.workspace.name ?? theWorkspace })}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">{t("Email addresses")}</Label>
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
              {emails.map((e) => (
                <Chip key={e} className="pr-1">
                  {e}
                  <button
                    type="button"
                    aria-label={t("Remove {{email}}", { email: e })}
                    onClick={() => setEmails(emails.filter((x) => x !== e))}
                    className="grid size-4 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </Chip>
              ))}
              <input
                id="invite-email"
                type="email"
                autoComplete="off"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                onBlur={commit}
                placeholder={emails.length > 0 ? t("Add another…") : t("teammate@company.com")}
                className="min-w-[120px] flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("Role")}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as WorkspaceRole)}>
                <SelectTrigger aria-label={t("Role")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKSPACE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {lookup(t, ROLE_WORD[r])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              {/* One answer today: an invitation is to the workspace, and an
                  agent is shared on its own page. Said, so nobody goes
                  looking for a per-invitation choice that is not there. */}
              <Label>{t("Can use")}</Label>
              <Select value="shared" disabled>
                <SelectTrigger aria-label={t("Can use")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shared">{t("All shared agents")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="m-0 text-meta text-muted-foreground">
            {t(
              "Members use shared agents and start their own threads. Admins also manage agents, people and billing. Viewers read what is shared with them.",
            )}
          </p>
          <div className="flex items-center gap-2 border-t border-hairline pt-3">
            <span className="flex-1 text-meta text-muted-foreground">
              {t("Or share a link that works for 7 days")}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copyLink()}
              disabled={linking}
            >
              {linking ? t("Making…") : t("Copy link")}
            </Button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={saving || all.length === 0}>
            {saving
              ? t("Sending…")
              : all.length > 1
                ? t("Send {{count}} invitation", {
                    count: all.length,
                    defaultValue_other: "Send {{count}} invitations",
                  })
                : t("Send invitation")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

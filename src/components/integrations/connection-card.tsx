import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import type { Connection, ProviderAvailability, ProviderId } from "@/lib/connections-api";
import type { Bundle } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Chip, SectionCard } from "@/components/section-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelative } from "@/lib/relative-time";
import {
  useDisconnect,
  useStartConnection,
  useSyncConnection,
  useUpdateConnection,
} from "@/hooks/use-connections";
import { DriveFolderDialog } from "./drive-folder-dialog";
import { GoogleDriveMark, NotionMark } from "./brand-marks";

/**
 * A brand mark lives in a 44px tile — the accent ceiling, and what that tile
 * was sized for.
 *
 * These were descriptive icons — a notebook for Notion, a folder for Drive — on
 * the reasoning that lucide 1 had dropped its brand icons and a logo would be
 * the odd entry out. That was true of a list where one row in five wore one.
 * Every connectable source is a product with a mark somebody recognises, and a
 * person scanning this page is looking for *Notion*: the fastest way to say
 * Notion is Notion's own mark.
 */
export const PROVIDER_MARK: Record<ProviderId, (props: { className?: string }) => ReactElement> = {
  notion: NotionMark,
  google_drive: GoogleDriveMark,
};

/**
 * How often a source is re-read. Hours rather than a cron expression: a routine
 * fires at 9am because somebody wants to read it at 9am, and a sync has no such
 * hour — only a staleness the team is willing to tolerate.
 */
const INTERVALS = [
  { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Daily" },
  { minutes: 10080, label: "Weekly" },
];

export function ConnectionCard({ connection }: { connection: Connection }) {
  const [pickingFolder, setPickingFolder] = useState(false);
  const update = useUpdateConnection();
  const sync = useSyncConnection();
  const disconnect = useDisconnect();
  const Mark = PROVIDER_MARK[connection.provider];

  const paused = connection.status === "paused";

  return (
    <SectionCard className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline">
            <Mark className="h-[22px] w-[22px]" />
          </span>
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="text-[15px] font-medium leading-tight [overflow-wrap:anywhere]">
              {connection.accountLabel}
              {connection.folderName ? ` · ${connection.folderName}` : ""}
            </span>
            <span className="text-[13px] leading-tight text-muted-foreground">
              {connection.bundleName ?? "a bundle"} · {connection.documentCount}{" "}
              {connection.documentCount === 1 ? "document" : "documents"}
              {connection.lastSyncAt ? ` · synced ${formatRelative(connection.lastSyncAt)}` : ""}
            </span>
          </span>
        </div>
        {/* Neutral grey = off or pending, amber = working. There is no third
            state and no red — a paused connection is not an error, it is a
            connection that is not running. */}
        <Chip tone={paused ? "neutral" : "on"}>
          {connection.needsFolder ? "Needs a folder" : paused ? "Paused" : "Active"}
        </Chip>
      </div>

      {connection.pausedReason ? (
        <p className="rounded-lg border border-hairline bg-background px-4 py-3 text-[13px] leading-[1.45] text-muted-foreground">
          {connection.pausedReason}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {connection.needsFolder ? (
          <Button size="sm" onClick={() => setPickingFolder(true)}>
            Choose a folder
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={paused || sync.isPending}
              onClick={() =>
                sync.mutate(connection.id, {
                  onSuccess: (outcome) =>
                    toast.success(
                      outcome.added + outcome.updated + outcome.removed === 0
                        ? "Nothing had changed."
                        : `${outcome.added} added, ${outcome.updated} updated, ${outcome.removed} removed.` +
                            (outcome.more ? " More to come — it will carry on shortly." : ""),
                    ),
                  onError: (err) => toast.error(err instanceof Error ? err.message : "Sync failed"),
                })
              }
            >
              <RefreshCw className={`h-3.5 w-3.5 ${sync.isPending ? "animate-spin" : ""}`} />
              {sync.isPending ? "Syncing…" : "Sync now"}
            </Button>

            <Select
              value={String(connection.syncIntervalMinutes)}
              onValueChange={(value) =>
                update.mutate({
                  id: connection.id,
                  patch: { syncIntervalMinutes: Number(value) },
                })
              }
            >
              <SelectTrigger className="h-8 w-[150px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map((option) => (
                  <SelectItem key={option.minutes} value={String(option.minutes)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                update.mutate({
                  id: connection.id,
                  patch: { status: paused ? "active" : "paused" },
                })
              }
            >
              {paused ? "Resume" : "Pause"}
            </Button>
          </>
        )}

        {/* Keeping the documents is the default, and the schema agrees:
            `documents.connection_id` is `on delete set null`. Disconnecting a
            source is not a request to unlearn what it taught. */}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          disabled={disconnect.isPending}
          onClick={() => {
            const alsoDelete = window.confirm(
              `Disconnect ${connection.accountLabel}?\n\n` +
                `OK — also delete the ${connection.documentCount} documents it imported.\n` +
                `Cancel — keep them in the bundle and just stop syncing.`,
            );
            disconnect.mutate(
              { id: connection.id, documents: alsoDelete ? "delete" : "keep" },
              {
                onSuccess: () => toast.success("Disconnected."),
                onError: (err) =>
                  toast.error(err instanceof Error ? err.message : "Could not disconnect"),
              },
            );
          }}
        >
          Disconnect
        </Button>
      </div>

      <DriveFolderDialog
        connectionId={connection.id}
        accountLabel={connection.accountLabel}
        open={pickingFolder}
        onOpenChange={setPickingFolder}
        saving={update.isPending}
        onChoose={(folder) =>
          update.mutate(
            { id: connection.id, patch: { folderId: folder.id, folderName: folder.name } },
            {
              onSuccess: () => {
                setPickingFolder(false);
                toast.success(`Syncing “${folder.name}”.`);
              },
              onError: (err) =>
                toast.error(err instanceof Error ? err.message : "Could not save that folder"),
            },
          )
        }
      />
    </SectionCard>
  );
}

/** The environment variables an operator sets to turn a provider on. */
const PROVIDER_ENV: Record<ProviderId, string> = {
  notion: "NOTION_CLIENT_ID and NOTION_CLIENT_SECRET",
  google_drive: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET",
};

/**
 * Sources that are built but not being offered yet.
 *
 * Drive is here for a reason that is not code: syncing a folder needs
 * `drive.readonly`, which Google classifies as a *restricted* scope, and an
 * unverified client shows every person who connects it an "unverified app"
 * warning and stops working past a hundred of them. Verification means a
 * third-party security assessment and weeks of waiting, renewed annually. Until
 * that is done, offering Drive on the hosted product would be selling something
 * whose first screen tells the buyer not to trust it.
 *
 * The card says "Coming soon" and nothing else — the environment variables are
 * deliberately not named here, unlike the unconfigured case below. A
 * self-hoster is under no such constraint and can turn Drive on today;
 * `docs/self-hosting.md` and `docs/integrations.md` are where they read how,
 * and they are the honest place for it, because "coming soon" is a statement
 * about this deployment rather than about the software.
 */
const SOON = new Set<ProviderId>(["google_drive"]);

const PROVIDER_BLURB: Record<ProviderId, string> = {
  notion: "The pages you tick in Notion's own picker, kept in step with a bundle.",
  google_drive:
    "A Drive folder — Docs, Sheets, Slides and text files — kept in step with a bundle.",
};

/**
 * A source that could be connected.
 *
 * An unconfigured provider is shown rather than hidden, saying which variables
 * would turn it on. Hiding it leaves a self-hoster reading documentation for a
 * feature their own build appears not to have.
 */
export function ConnectSourceCard({
  provider,
  bundles,
}: {
  provider: ProviderAvailability;
  bundles: Bundle[];
}) {
  const [bundleId, setBundleId] = useState<string>("");
  const start = useStartConnection();
  const Mark = PROVIDER_MARK[provider.id];
  // Only when it is off. A deployment that has set the credentials has it, so
  // saying "coming soon" there would be the page contradicting its own buttons.
  const soon = !provider.configured && SOON.has(provider.id);

  return (
    <SectionCard className={`flex flex-col gap-4 ${provider.configured ? "" : "opacity-70"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline">
            <Mark className="h-[22px] w-[22px]" />
          </span>
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="font-dm text-[18px] font-medium leading-tight">{provider.label}</span>
            <span className="text-[13px] leading-tight text-muted-foreground">
              {PROVIDER_BLURB[provider.id]}
            </span>
          </span>
        </div>
        {/* Neutral, because grey is this page's word for off, pending and not
            yet built alike. Amber would claim it does something. */}
        {soon ? <Chip tone="neutral">Coming soon</Chip> : null}
      </div>

      {provider.configured ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={bundleId} onValueChange={setBundleId}>
            <SelectTrigger className="h-9 w-[220px] text-sm">
              <SelectValue placeholder="Into which bundle?" />
            </SelectTrigger>
            <SelectContent>
              {bundles.map((bundle) => (
                <SelectItem key={bundle.id} value={bundle.id}>
                  {bundle.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={!bundleId || start.isPending}
            onClick={() =>
              start.mutate(
                { provider: provider.id, bundleId },
                {
                  onError: (err) =>
                    toast.error(err instanceof Error ? err.message : "Could not start that"),
                },
              )
            }
          >
            {start.isPending ? "Opening…" : "Connect"}
          </Button>
        </div>
      ) : soon ? (
        <p className="text-[13px] leading-[1.45] text-muted-foreground">Coming soon.</p>
      ) : (
        <p className="text-[13px] leading-[1.45] text-muted-foreground">
          Not configured on this deployment. An operator sets{" "}
          <span className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-xs">
            {PROVIDER_ENV[provider.id]}
          </span>{" "}
          to turn it on.
        </p>
      )}
    </SectionCard>
  );
}

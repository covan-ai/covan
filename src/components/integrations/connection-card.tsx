import { useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { lookup, msg, Trans, useTranslation, type TFunction } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import type {
  Connection,
  ConnectionPausedCode,
  ProviderAvailability,
  ProviderId,
} from "@/lib/connections-api";
import type { Bundle } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/chip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
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
import { formatRelative } from "@/lib/relative-time";
import {
  useConnectionRuns,
  useDisconnect,
  useReconnectConnection,
  useStartConnection,
  useSyncConnection,
  useUpdateConnection,
} from "@/hooks/use-connections";
import { syncedWords } from "@/lib/day-groups";
import { DriveFolderDialog } from "./drive-folder-dialog";
import { PROVIDER_MARK } from "./brand-marks";
import { AppLogo } from "./app-logo";
import { IntegrationCard, IntegrationRow } from "./integration-row";

/** What each source is called, beside the account it reads. Brand names, untranslated. */
const PROVIDER_LABEL: Record<ProviderId, string> = {
  notion: "Notion",
  google_drive: "Google Drive",
};

/** "every 30 minutes", "daily" — the interval as part of a sentence. */
function intervalWords(minutes: number, t: TFunction, locale: string): string {
  const found = INTERVALS.find((i) => i.minutes === minutes);
  return found
    ? lookup(t, found.label).toLocaleLowerCase(locale)
    : t("every {{minutes}} minutes", { minutes });
}

/**
 * How often a source is re-read. Hours rather than a cron expression: a routine
 * fires at 9am because somebody wants to read it at 9am, and a sync has no such
 * hour — only a staleness the team is willing to tolerate.
 */
const INTERVALS = [
  { minutes: 15, label: msg("Every 15 minutes") },
  { minutes: 30, label: msg("Every 30 minutes") },
  { minutes: 60, label: msg("Every hour") },
  { minutes: 360, label: msg("Every 6 hours") },
  { minutes: 1440, label: msg("Daily") },
  { minutes: 10080, label: msg("Weekly") },
];

/**
 * What a person can actually do about a pause.
 *
 * Decided from the code rather than from the sentence beside it, because the
 * right action differs and offering the wrong one wastes somebody's afternoon:
 * resuming a revoked grant fails on the first sync and pauses the connection
 * again, with a message they have already read.
 *
 *   - `newGrant`   — only a fresh grant fixes it. Resume is hidden, because it
 *                    cannot work.
 *   - `decide`     — the engine is asking a question. Resuming means "yes,
 *                    really remove those", and reconnecting is the other answer.
 *   - `operator`   — nothing the person on this page can do. The deployment
 *                    stopped offering the provider; say so and offer neither.
 *   - `resume`     — the ordinary case, including a person's own pause.
 */
function pauseAction(
  code: ConnectionPausedCode | null,
): "newGrant" | "decide" | "operator" | "resume" {
  switch (code) {
    case "grant_revoked":
    case "owner_gone":
    case "restored":
      return "newGrant";
    case "access_narrowed":
      return "decide";
    case "provider_unconfigured":
    case "unknown_provider":
      return "operator";
    default:
      return "resume";
  }
}

/**
 * A connected source as a row (A8): what it reads, into which folder, how
 * often and for whom, how its last sync went, and Manage. A Drive connection
 * still waiting for its folder offers that instead, since it is the next step.
 */
export function ConnectionRow({
  connection,
  connectedBy,
}: {
  connection: Connection;
  /** The grant holder's name, when they are still a member. */
  connectedBy?: string | null;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [pickingFolder, setPickingFolder] = useState(false);
  const [managing, setManaging] = useState(false);
  const update = useUpdateConnection();
  const sync = useSyncConnection();
  const disconnect = useDisconnect();
  const reconnect = useReconnectConnection();
  const Mark = PROVIDER_MARK[connection.provider];
  const providerName = PROVIDER_LABEL[connection.provider];
  const folder = connection.bundleName ?? t("a folder");

  const paused = connection.status === "paused";
  // The last run's sentence, when it had one: which files it could not import
  // and why. The engine has always written it; nothing on screen used to read
  // it, so a folder of files nothing could read synced as an empty bundle with
  // no explanation anywhere a person would look. A pause already says more.
  const runs = useConnectionRuns(connection.id, !connection.needsFolder);
  const lastRun = runs.data?.[0];
  const lastRunNote = !connection.pausedReason && lastRun?.error ? lastRun : null;

  const syncNow = () =>
    sync.mutate(connection.id, {
      onSuccess: (outcome) =>
        toast.success(
          outcome.added + outcome.updated + outcome.removed === 0
            ? t("Nothing had changed.")
            : t("{{added}} added, {{updated}} updated, {{removed}} removed.", {
                added: outcome.added,
                updated: outcome.updated,
                removed: outcome.removed,
              }) + (outcome.more ? ` ${t("More to come — it will carry on shortly.")}` : ""),
        ),
      onError: (err) => toast.error(err instanceof Error ? err.message : t("Sync failed")),
    });
  const action = paused ? pauseAction(connection.pausedCode) : "resume";
  const reconnectButton = (
    <Button
      size="sm"
      variant={action === "newGrant" ? "default" : "secondary"}
      disabled={reconnect.isPending}
      onClick={() =>
        reconnect.mutate(connection.id, {
          onError: (err) =>
            toast.error(err instanceof Error ? err.message : t("Could not start that")),
        })
      }
    >
      {t("Reconnect")}
    </Button>
  );

  const status = connection.needsFolder
    ? { state: "waiting" as const, text: t("Needs a folder") }
    : paused
      ? { state: "idle" as const, text: t("Paused") }
      : connection.lastSyncAt
        ? {
            state: "done" as const,
            text: syncedWords(connection.lastSyncAt, undefined, t, locale),
          }
        : { state: "idle" as const, text: t("Not synced yet") };
  const description = [
    connection.accountLabel + (connection.folderName ? ` · ${connection.folderName}` : ""),
    t("{{count}} file in {{folder}}", {
      count: connection.documentCount,
      folder,
      defaultValue_other: "{{count}} files in {{folder}}",
    }),
    intervalWords(connection.syncIntervalMinutes, t, locale),
    connectedBy ? t("connected by {{name}}", { name: connectedBy }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <IntegrationRow
        logo={<AppLogo mark={Mark} name={providerName} size={36} />}
        name={providerName}
        description={description}
        status={status}
        action={
          connection.needsFolder ? (
            <Button size="sm" onClick={() => setPickingFolder(true)}>
              {t("Choose a folder")}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setManaging(true)}>
              {t("Manage")}
            </Button>
          )
        }
      />

      <Dialog open={managing} onOpenChange={setManaging}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>
              {providerName} · {connection.accountLabel}
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <p className="m-0 text-sm text-muted-foreground">
              {t("{{count}} document in {{folder}}", {
                count: connection.documentCount,
                folder,
                defaultValue_other: "{{count}} documents in {{folder}}",
              })}
              {connection.lastSyncAt
                ? ` · ${t("synced {{when}}", {
                    when: formatRelative(connection.lastSyncAt, undefined, t, locale),
                  })}`
                : ""}
            </p>
            {connection.pausedReason ? (
              <p className="rounded-lg border border-hairline bg-background px-4 py-3 text-meta leading-[1.45] text-muted-foreground">
                {connection.pausedReason}
              </p>
            ) : lastRunNote ? (
              <p className="rounded-lg border border-hairline bg-background px-4 py-3 text-meta leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]">
                {t("Last sync {{when}}: {{error}}", {
                  when: formatRelative(lastRunNote.startedAt, undefined, t, locale),
                  error: lastRunNote.error,
                })}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {connection.needsFolder ? (
                <Button size="sm" onClick={() => setPickingFolder(true)}>
                  {t("Choose a folder")}
                </Button>
              ) : action === "newGrant" ? (
                // Resume is not offered at all. It would start a sync against a token
                // the provider has already refused, fail on the first call, and pause
                // the connection again with the message that is already on screen.
                reconnectButton
              ) : action === "operator" ? (
                // Nothing to press. The deployment stopped offering this provider,
                // which is a configuration somebody else holds — the sentence above
                // says which variables, and a button here would only fail.
                <span className="text-meta text-muted-foreground">
                  {t("An operator has to set this up again before it can resume.")}
                </span>
              ) : action === "decide" ? (
                <>
                  <Button
                    size="sm"
                    disabled={update.isPending}
                    onClick={() =>
                      update.mutate({ id: connection.id, patch: { status: "active" } })
                    }
                  >
                    {t("Remove them and resume")}
                  </Button>
                  {/* The other answer to the same question, and the more likely right
                one: the documents are still there, this grant just cannot see
                them. */}
                  {reconnectButton}
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={paused || sync.isPending}
                    onClick={syncNow}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${sync.isPending ? "animate-spin" : ""}`} />
                    {sync.isPending ? t("Syncing…") : t("Sync now")}
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
                          {lookup(t, option.label)}
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
                    {paused ? t("Resume") : t("Pause")}
                  </Button>
                  {/* Offered on a working connection too, quietly. Replacing a grant
                is the answer to "this is syncing as the wrong person" as well
                as to "this has stopped", and the old route to it was to
                disconnect and start again — which left the documents orphaned
                until the next sync adopted them back. */}
                  {!paused && reconnectButton}
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
                    [
                      t("Disconnect {{account}}?", { account: connection.accountLabel }),
                      t("OK — also delete the {{count}} document it imported.", {
                        count: connection.documentCount,
                        defaultValue_other: "OK — also delete the {{count}} documents it imported.",
                      }),
                      t("Cancel — keep them in the bundle and just stop syncing."),
                    ].join("\n\n"),
                  );
                  disconnect.mutate(
                    { id: connection.id, documents: alsoDelete ? "delete" : "keep" },
                    {
                      onSuccess: () => toast.success(t("Disconnected.")),
                      onError: (err) =>
                        toast.error(err instanceof Error ? err.message : t("Could not disconnect")),
                    },
                  );
                }}
              >
                {t("Disconnect")}
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <DriveFolderDialog
        connectionId={connection.id}
        accountLabel={connection.accountLabel}
        open={pickingFolder}
        onOpenChange={setPickingFolder}
        saving={update.isPending}
        onChoose={(picked) =>
          update.mutate(
            { id: connection.id, patch: { folderId: picked.id, folderName: picked.name } },
            {
              // Choosing the folder starts the first sync now rather than at the
              // engine's next tick, up to five minutes away — long enough for a
              // person who just connected a folder to decide it is empty. The
              // tick may still pick the same connection up meanwhile; two runs
              // reconcile to the same documents (one row per file at the
              // source), so the second simply finds less to do.
              onSuccess: () => {
                setPickingFolder(false);
                toast.success(t("Syncing “{{folder}}”.", { folder: picked.name }));
                syncNow();
              },
              onError: (err) =>
                toast.error(err instanceof Error ? err.message : t("Could not save that folder")),
            },
          )
        }
      />
    </>
  );
}

/** The environment variables an operator sets to turn a provider on. Identifiers, untranslated. */
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
  notion: msg("The pages you tick in Notion's own picker, kept in step with a bundle."),
  google_drive: msg(
    "A Drive folder — Docs, Sheets, Slides and text files — kept in step with a bundle.",
  ),
};

/**
 * A source that could be connected, in the Available grid (A8). Connect asks
 * which folder it keeps in step, then hands the browser to the provider.
 *
 * An unconfigured provider is shown rather than hidden, saying which variables
 * would turn it on. Hiding it leaves a self-hoster reading documentation for a
 * feature their own build appears not to have.
 */
export function SourceCard({
  provider,
  bundles,
}: {
  provider: ProviderAvailability;
  bundles: Bundle[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [bundleId, setBundleId] = useState<string>("");
  const start = useStartConnection();
  const Mark = PROVIDER_MARK[provider.id];
  // Only when it is off. A deployment that has set the credentials has it, so
  // saying "coming soon" there would be the page contradicting its own buttons.
  const soon = !provider.configured && SOON.has(provider.id);

  return (
    <>
      <IntegrationCard
        logo={<AppLogo mark={Mark} name={provider.label} size={28} />}
        name={provider.label}
        note={
          soon ? (
            <Chip size="sm">{t("Coming soon")}</Chip>
          ) : !provider.configured ? (
            <Chip size="sm">{t("Not configured")}</Chip>
          ) : null
        }
        description={
          provider.configured || soon ? (
            lookup(t, PROVIDER_BLURB[provider.id])
          ) : (
            <Trans
              t={t}
              i18nKey="Not configured on this deployment. An operator sets <code>{{variables}}</code> to turn it on."
              values={{ variables: PROVIDER_ENV[provider.id] }}
              components={{ code: <span className="font-mono text-xs" /> }}
            />
          )
        }
        action={
          provider.configured ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              {t("Connect")}
            </Button>
          ) : undefined
        }
      />

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setBundleId("");
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("Connect {{provider}}", { provider: provider.label })}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <p className="m-0 text-sm text-muted-foreground">
              {lookup(t, PROVIDER_BLURB[provider.id])}
            </p>
            {bundles.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">
                {t(
                  "A connection keeps a folder in Knowledge current, so there has to be one to keep. Make one in Knowledge first.",
                )}
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label>{t("Into which folder")}</Label>
                <Select value={bundleId} onValueChange={setBundleId}>
                  <SelectTrigger aria-label={t("Into which folder")}>
                    <SelectValue placeholder={t("Choose a folder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {bundles.map((bundle) => (
                      <SelectItem key={bundle.id} value={bundle.id}>
                        {bundle.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={!bundleId || start.isPending}
              onClick={() =>
                start.mutate(
                  { provider: provider.id, bundleId },
                  {
                    onError: (err) =>
                      toast.error(err instanceof Error ? err.message : t("Could not start that")),
                  },
                )
              }
            >
              {start.isPending ? t("Opening…") : t("Connect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

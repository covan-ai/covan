import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { lookup, msg, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { AgentMark } from "@/components/agent-mark";
import { Chip } from "@/components/chip";
import { DataTable } from "@/components/data-table";
import { DocumentPreviewDialog } from "@/components/document-preview-dialog";
import { SectionLabel, SectionTitle } from "@/components/section";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type CoverageAgent, type RevisitDocument } from "@/lib/api-client";
import { ageWords, missedShare } from "@/lib/stale-documents";

const WINDOWS = [7, 30, 90] as const;
const ALL = "__all";

/**
 * The share an agent has to miss before it is worth pointing at.
 *
 * A third is not a threshold anybody derived; it is the point past which the
 * honest sentence changes. Below it, "some questions were not covered" is
 * ordinary and always will be — people ask about things no handbook has. Above
 * it, most of what this agent is being asked is not in what it was given, and
 * that is a different fact about the workspace.
 */
const MISS_SHARE_WORTH_POINTING_AT = 1 / 3;

/** Below this many replies a share is noise, and nobody is pointed at. */
const MIN_ASKED_TO_POINT_AT = 10;

const pct = (part: number, of: number) => (of === 0 ? 0 : Math.round((part / of) * 100));

/** The three buckets, darkest first, as the legend reads them. */
const BUCKETS = [
  { key: "covered", label: msg("Found a passage"), swatch: "bg-foreground" },
  { key: "fallback", label: msg("Fell back to whole documents"), swatch: "bg-foreground/50" },
  { key: "ungrounded", label: msg("Nothing close"), swatch: "bg-input" },
] as const;

/**
 * Settings › Coverage (A18): what the team asked that nothing written was
 * close to.
 *
 * `messages.grounding` (0039) records, on every reply, which of three ways it
 * was grounded — a passage that cleared the similarity floor, the
 * whole-document fallback, or nothing. `0053` reads it back by agent and by
 * window; 0134 adds one agent at a time and the documents worth revisiting.
 *
 * **The middle bucket is the feature.** A reply that fell back to whole
 * documents is usually still a good answer, and it means no passage in
 * anything the team wrote was close to what was asked — the question the team
 * keeps asking that nobody has written down.
 *
 * **By agent and by window, never by person and never the question itself.**
 * The functions behind this select no `user_id` and return no content.
 *
 * An admin's; `available: false` is the window before the migration, and the
 * page then shows the title alone rather than an error.
 */
export function WorkspaceCoverageSection() {
  const { t } = useTranslation();
  const locale = useLocale();
  const [days, setDays] = useState<number>(30);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [opened, setOpened] = useState<RevisitDocument | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["coverage", "workspace", days, agentId],
    queryFn: () => (agentId ? api.coverage.workspace(days, agentId) : api.coverage.workspace(days)),
  });
  // The agent filter lists every agent the workspace figures name, so it is
  // read from the unfiltered answer and kept while one agent is shown.
  const { data: everyone } = useQuery({
    queryKey: ["coverage", "workspace", days, null],
    queryFn: () => api.coverage.workspace(days),
  });
  const { data: revisit } = useQuery({
    queryKey: ["coverage", "documents", days, agentId],
    queryFn: () => api.coverage.documents(days, agentId ?? undefined),
    enabled: data?.available === true,
  });

  const filters = (
    <div className="flex flex-wrap gap-2">
      <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
        <SelectTrigger aria-label={t("Window")} className="w-auto">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WINDOWS.map((w) => (
            <SelectItem key={w} value={String(w)}>
              {t("Last {{count}} day", { count: w, defaultValue_other: "Last {{count}} days" })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={agentId ?? ALL} onValueChange={(v) => setAgentId(v === ALL ? null : v)}>
        <SelectTrigger aria-label={t("Agent")} className="w-auto">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("All agents")}</SelectItem>
          {(everyone?.agents ?? []).map((a) => (
            <SelectItem key={a.agentId} value={a.agentId}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const title = (
    <SectionTitle
      title={t("Coverage")}
      lede={t(
        "What the team asked that nothing written was close to. Counts by agent and by window, never the questions themselves and never who asked.",
      )}
      action={data?.available ? filters : undefined}
    />
  );

  if (isLoading || !data?.available) return title;

  const { totals, agents } = data;
  // 0053 returns every agent, including the ones nobody asked anything in
  // this window. They are not rows — a list of zeroes buries the agents that
  // have figures — but they are counted in one line under the list.
  const asked = agents.filter((a) => a.answers > 0).sort((a, b) => b.answers - a.answers);
  const untouched = agentId ? 0 : agents.length - asked.length;
  // The callout is for the one agent missing the largest share, past a third,
  // and only once it has been asked enough for a share to mean something.
  const missShare = (a: CoverageAgent) => (a.fallback + a.ungrounded) / a.answers;
  const worst = asked
    .filter((a) => a.answers >= MIN_ASKED_TO_POINT_AT)
    .reduce<CoverageAgent | undefined>(
      (w, a) => (!w || missShare(a) > missShare(w) ? a : w),
      undefined,
    );
  const worstShare = worst ? missShare(worst) : 0;
  const documents = revisit?.documents ?? [];

  return (
    <>
      {title}

      <SectionLabel>{t("How replies were grounded")}</SectionLabel>
      {totals.answers === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "Nothing in this window. Once somebody asks an agent a question, whether anything you wrote was close to it lands here.",
          )}
        </p>
      ) : (
        <>
          <div className="mb-2.5 flex flex-wrap gap-4 text-meta text-muted-foreground">
            {BUCKETS.map((b) => (
              <span key={b.key} className="inline-flex items-center gap-1.5">
                <i className={`inline-block size-3 rounded-[3px] ${b.swatch}`} aria-hidden />
                {lookup(t, b.label)}
              </span>
            ))}
          </div>
          <ul className="m-0 list-none p-0">
            {asked.map((a, i) => (
              <AgentBar key={a.agentId} agent={a} first={i === 0} />
            ))}
          </ul>
        </>
      )}

      {untouched > 0 && (
        <p className="mt-2 text-meta text-muted-foreground">
          {t("{{count}} agent nobody asked anything in this window.", {
            count: untouched,
            defaultValue_other: "{{count}} agents nobody asked anything in this window.",
          })}
        </p>
      )}
      {/* A figure whose denominator is a sample rather than a census says so
          on the same screen as the figure. */}
      {totals.unrecorded > 0 && (
        <p className="mt-2 text-meta text-muted-foreground">
          {t(
            "{{count}} reply in this window predates the recording and is left out of every figure above.",
            {
              count: totals.unrecorded,
              defaultValue_other:
                "{{count}} replies in this window predate the recording and are left out of every figure above.",
            },
          )}
        </p>
      )}

      {worst && worstShare >= MISS_SHARE_WORTH_POINTING_AT && (
        <div className="mt-5 flex items-start gap-3 rounded-xl border border-border p-4">
          <StatusDot state="waiting" className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-sm font-medium">
              {missedShare(worstShare) === "most"
                ? t("Most of what {{agent}} is asked is not in what it was given", {
                    agent: worst.name,
                  })
                : missedShare(worstShare) === "half"
                  ? t("More than half of what {{agent}} is asked is not in what it was given", {
                      agent: worst.name,
                    })
                  : t("More than a third of what {{agent}} is asked is not in what it was given", {
                      agent: worst.name,
                    })}
            </div>
            <p className="mb-3 text-sm text-muted-foreground">
              {t(
                "The middle bucket is the one to act on: those replies were still usable, but no passage in anything the team wrote was close. That is the question people keep asking that nobody has written down.",
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link to="/agents/$agentId/knowledge" params={{ agentId: worst.agentId }}>
                  {t("Add documents to {{agent}}", { agent: worst.name })}
                </Link>
              </Button>
              <Button variant="secondary" asChild>
                <Link to="/agents/$agentId/configuration" params={{ agentId: worst.agentId }}>
                  {t("See the folders it reads")}
                </Link>
              </Button>
            </div>
          </div>
        </div>
      )}

      {documents.length > 0 && (
        <>
          <SectionLabel
            action={
              <span className="font-normal">{t("Old enough to doubt, used enough to matter")}</span>
            }
          >
            {t("Documents worth revisiting")}
          </SectionLabel>
          <div className="overflow-x-auto">
            <DataTable
              label={t("Documents worth revisiting")}
              rows={documents}
              rowKey={(d) => d.documentId}
              columns={[
                {
                  key: "doc",
                  header: t("Document"),
                  cell: (d) => <Chip tone="code">{d.name}</Chip>,
                },
                {
                  key: "age",
                  header: t("Age"),
                  cell: (d) => (
                    <span className="text-muted-foreground">
                      {ageWords(d.createdAt, undefined, t)}
                    </span>
                  ),
                },
                {
                  key: "uses",
                  header: t("Used in replies, {{days}} d", { days }),
                  num: true,
                  cell: (d) => d.uses.toLocaleString(locale),
                },
                {
                  key: "readBy",
                  header: t("Read by"),
                  hideBelow: "md",
                  cell: (d) => (
                    <span className="flex flex-wrap gap-1">
                      {d.readBy.map((a) => (
                        <Chip key={a.agentId}>{a.name}</Chip>
                      ))}
                    </span>
                  ),
                },
                {
                  key: "open",
                  header: <span className="sr-only">{t("Open")}</span>,
                  className: "w-20 text-right",
                  cell: (d) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("Open {{name}}", { name: d.name })}
                      onClick={() => setOpened(d)}
                    >
                      {t("Open")}
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        </>
      )}

      <p className="mt-4 text-meta text-muted-foreground">
        {t(
          "Counts come from every thread in the workspace, private ones included. Nothing but the number crosses: not who asked, not what they asked.",
        )}
      </p>

      {opened && (
        <DocumentPreviewDialog
          documentId={opened.documentId}
          name={opened.name}
          onClose={() => setOpened(null)}
        />
      )}
    </>
  );
}

/** One agent: its mark and name, the three buckets as one bar, and the count. */
function AgentBar({ agent, first }: { agent: CoverageAgent; first: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const missed = pct(agent.fallback + agent.ungrounded, agent.answers);
  const shares = BUCKETS.map((b) => ({
    ...b,
    label: lookup(t, b.label),
    share: pct(agent[b.key], agent.answers),
  }));
  return (
    <li className="grid min-h-11 grid-cols-[150px_minmax(0,1fr)_120px] items-center gap-3.5 border-b border-hairline last:border-b-0">
      <span className="flex min-w-0 items-center gap-2.5 text-sm font-medium">
        <AgentMark agent={agent} size={24} />
        <span className="truncate">{agent.name}</span>
      </span>
      <span
        role="img"
        aria-label={`${agent.name}: ${shares.map((s) => `${s.share}% ${s.label.toLocaleLowerCase(locale)}`).join(", ")}`}
        className="flex h-4 gap-0.5"
      >
        {shares
          .filter((s) => s.share > 0)
          .map((s) => (
            <i
              key={s.key}
              className={`block h-4 first:rounded-l-[4px] last:rounded-r-[4px] ${s.swatch}`}
              style={{ width: `${s.share}%` }}
            />
          ))}
      </span>
      <span className="text-right text-meta text-muted-foreground tabular-nums">
        {first
          ? t("{{asked}} asked · {{missed}}% not covered", {
              asked: agent.answers.toLocaleString(locale),
              missed,
            })
          : t("{{asked}} asked · {{missed}}%", {
              asked: agent.answers.toLocaleString(locale),
              missed,
            })}
      </span>
    </li>
  );
}

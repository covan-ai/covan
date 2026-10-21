import { Check, FileText, Lock, Repeat } from "lucide-react";
import { AgentAvatar, AvatarStack } from "@/components/avatars";
import { AppLogo } from "@/components/integrations/app-logo";
import { GoogleDriveMark, NotionMark, SlackMark } from "@/components/integrations/brand-marks";
import { Chip, DataRow } from "@/components/section-card";
import type { DemoKind } from "@/lib/onboarding-config";
import { cn } from "@/lib/utils";

/**
 * The four looping demos on the intro screens.
 *
 * Built from the product's own pieces — the question bubble, a reply with its
 * source chip, the app tile, the step trail, a data row, the avatars — rather
 * than drawn, so what the screens show is what the app looks like. Everything
 * in them is invented (a stand-in file, stand-in people) and nothing claims a
 * number: DESIGN.md's first failure mode is a picture the code cannot back.
 *
 * Each demo is a well with its layers stacked in one grid cell, so nothing
 * reflows as the loop turns (`styles.css`, `demo-*`). A layer that only exists
 * in passing is `motion-reduce:hidden`; what is left with motion off is the
 * demo's final frame, which is the state that has to read on its own.
 *
 * `aria-hidden` throughout: the headline above says what the screen means,
 * and a screen reader has nothing to gain from a loop.
 */
export function MiniDemo({ kind, className }: { kind: DemoKind; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "mx-auto h-44 w-full max-w-sm overflow-hidden rounded-lg border border-hairline bg-background p-4",
        className,
      )}
    >
      {kind === "documents" && <DocumentsDemo />}
      {kind === "apps" && <AppsDemo />}
      {kind === "schedule" && <ScheduleDemo />}
      {kind === "team" && <TeamDemo />}
    </div>
  );
}

/** Layers stacked in one cell. */
const STACK = "grid [&>*]:col-start-1 [&>*]:row-start-1";

function DocumentsDemo() {
  return (
    <div className="flex h-full flex-col justify-between">
      <div className="flex justify-end">
        <span className="rounded-2xl bg-bubble px-3.5 py-2 text-sm">What's our refund window?</span>
      </div>
      <div className={STACK}>
        <div className="demo-slot-2 flex items-center gap-1 self-end px-1 pb-1 motion-reduce:hidden">
          <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
          <span
            className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground"
            style={{ animationDelay: "0.15s" }}
          />
          <span
            className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground"
            style={{ animationDelay: "0.3s" }}
          />
        </div>
        <div className="demo-hold-3 space-y-2">
          <p className="text-sm leading-[1.5]">
            Thirty days from delivery, and fourteen for anything opened.
          </p>
          <span className="inline-flex items-center gap-1.5 rounded-sm bg-surface px-2 py-1 text-xs font-medium text-muted-foreground">
            <FileText className="h-3 w-3" />
            Refund policy.pdf
          </span>
        </div>
      </div>
    </div>
  );
}

function AppsDemo() {
  return (
    <div
      className="flex h-full flex-col justify-between"
      style={{ "--demo-period": "3.2s" } as never}
    >
      <div className="flex items-center gap-2">
        <AppLogo mark={NotionMark} name="Notion" size={28} />
        <AppLogo mark={GoogleDriveMark} name="Google Drive" size={28} />
        <AppLogo mark={SlackMark} name="Slack" size={28} />
      </div>
      <ol className="space-y-1.5 text-sm">
        <TrailRow done>Searched the wiki</TrailRow>
        <TrailRow done className="demo-hold-2">
          Read the page
        </TrailRow>
        <TrailRow className="demo-hold-3">Posting the summary</TrailRow>
      </ol>
    </div>
  );
}

function TrailRow({
  done,
  className,
  children,
}: {
  done?: boolean;
  className?: string;
  children: string;
}) {
  return (
    <li className={cn("flex items-center gap-2.5", className)}>
      {done ? (
        <span className="grid h-4 w-4 shrink-0 place-items-center rounded-sm bg-primary text-primary-foreground">
          <Check className="h-3 w-3" />
        </span>
      ) : (
        <span className="step-running h-4 w-4 shrink-0 rounded-sm" />
      )}
      <span className={done ? "text-muted-foreground" : "font-medium"}>{children}</span>
    </li>
  );
}

function ScheduleDemo() {
  return (
    <div className="flex h-full items-center" style={{ "--demo-period": "3s" } as never}>
      <DataRow
        className="w-full"
        icon={
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface">
            <Repeat className="h-4 w-4 text-muted-foreground" />
          </span>
        }
        title="Monday digest"
        meta="Every Monday · to the team"
        trailing={
          <span className={STACK}>
            <span className="demo-slot-2 flex items-center gap-2 text-meta text-muted-foreground motion-reduce:hidden">
              <span className="step-running h-3 w-3 rounded-sm" />
              Running
            </span>
            <Chip tone="on" className="demo-hold-3">
              Sent
            </Chip>
          </span>
        }
      />
    </div>
  );
}

const PEOPLE = [
  { id: "a", name: "Ada", avatarUrl: null },
  { id: "g", name: "Grace", avatarUrl: null },
  { id: "l", name: "Linus", avatarUrl: null },
];

function TeamDemo() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4"
      style={{ "--demo-period": "3s" } as never}
    >
      <div className="flex items-center gap-3">
        <AvatarStack people={PEOPLE} className="h-7 w-7 text-[10px]" />
        <span className="text-meta text-muted-foreground">train one assistant</span>
        <AgentAvatar emoji="🧭" className="h-9 w-9 text-lg" />
      </div>
      <div className="flex items-center gap-2">
        <PrivateBubble className="demo-slot-1">Ada's conversation</PrivateBubble>
        <PrivateBubble className="demo-hold-2">Grace's conversation</PrivateBubble>
      </div>
    </div>
  );
}

function PrivateBubble({ className, children }: { className?: string; children: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-2xl bg-bubble px-3 py-1.5 text-xs font-medium",
        className,
      )}
    >
      <Lock className="h-3 w-3 text-muted-foreground" />
      {children}
    </span>
  );
}

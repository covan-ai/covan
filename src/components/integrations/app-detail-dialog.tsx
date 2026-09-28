import { toast } from "sonner";

import { assetSrc } from "@/lib/api-client";
import { canConnectToolkit, type ComposioToolkit } from "@/lib/connections-api";
import { useComposioToolkitDetail, useConnectComposio } from "@/hooks/use-connections";
import { AppLogo } from "@/components/integrations/app-logo";
import { Chip } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * What an application is, before somebody agrees to connect it.
 *
 * WHAT THIS REPLACED. Clicking a tile in the catalogue used to *connect* it:
 * one click on a name in a grid of fifteen hundred, and the browser left the
 * product for a third party's consent screen. What the person had been told
 * first was one truncated line. The tile now opens this, and Connect lives
 * inside it.
 *
 * WHY A DIALOG AND NOT AN EXPANDING TILE. `DESIGN.md`'s fifth failure mode is a
 * mechanism with no keyboard or small-screen equivalent, and Radix gives the
 * focus trap, Escape and focus-returned-to-the-tile for nothing. An expansion
 * would also reflow every tile below it — which is the bug
 * `tool-connection-card.tsx` records about the add-service form, in this same
 * section, for this same reason.
 *
 * WHAT IT MAY NOT DO. Failure mode #1: no claim the code cannot back. So the
 * operation count renders only when the route could earn one, and an
 * application whose operations could not be read says nothing about how many it
 * has rather than saying zero. `total` is null far more often than not.
 *
 * The amber budget is one element: the 36px chip inside the ink Connect button.
 * Every chip here is neutral.
 */
export function AppDetailDialog({
  toolkit,
  onClose,
}: {
  toolkit: ComposioToolkit | null;
  onClose: () => void;
}) {
  // Keyed off the toolkit rather than a separate `open`, so there is one source
  // of truth for "is a card showing" and it is the same value the card renders.
  const detail = useComposioToolkitDetail(toolkit?.slug ?? null);
  const connect = useConnectComposio();
  const connectable = toolkit ? canConnectToolkit(toolkit) : false;

  return (
    <Dialog open={Boolean(toolkit)} onOpenChange={(next) => !next && onClose()}>
      {toolkit ? (
        // `gap-0 p-0` and a flex column, not `overflow-y-auto` on the whole
        // card: the body is what scrolls, so Connect stays on screen for an
        // application with forty operations. `pr-12` clears the close button.
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
          <DialogHeader className="shrink-0 border-b border-hairline px-5 py-4 pr-12 text-left">
            <div className="flex items-start gap-3">
              {/* Default size, no override. DESIGN.md: a third party's mark
                  renders at 22px inside the 44px tile "and never larger or
                  anywhere else" — a dialog is not an exception to that. */}
              <AppLogo src={assetSrc(toolkit.logoPath)} name={toolkit.name} />
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle className="[overflow-wrap:anywhere]">{toolkit.name}</DialogTitle>
                <span className="font-mono text-xs text-muted-foreground">{toolkit.slug}</span>
              </div>
            </div>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
            {/* The whole description. The grid truncates it to one line, which
                is the right call in a grid and the reason this card exists. */}
            <DialogDescription className="text-base leading-[1.6] text-foreground">
              {toolkit.description || "Composio publishes no description for this application."}
            </DialogDescription>

            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone="neutral">{authLabel(toolkit)}</Chip>
              {/* Only when the route could back it. See the note at the top. */}
              {detail.data?.total != null ? (
                <Chip tone="neutral">{`${detail.data.total} operation${detail.data.total === 1 ? "" : "s"}`}</Chip>
              ) : null}
            </div>

            <Operations
              state={
                detail.isPending
                  ? { kind: "loading" }
                  : detail.isError || !detail.data || detail.data.operations === null
                    ? { kind: "unavailable" }
                    : { kind: "ok", operations: detail.data.operations, more: detail.data.more }
              }
            />
          </div>

          <DialogFooter className="shrink-0 border-t border-hairline px-5 py-4">
            {connectable ? (
              <Button
                disabled={connect.isPending}
                onClick={() =>
                  connect.mutate(
                    { toolkit: toolkit.slug, label: toolkit.name, noAuth: toolkit.noAuth },
                    { onError: (err: Error) => toast.error(err.message) },
                  )
                }
              >
                {connect.isPending ? "Opening…" : "Connect"}
              </Button>
            ) : (
              // No button at all rather than a disabled one. The thing standing
              // in the way is a job somebody has to do in Composio's dashboard,
              // not a state this page is waiting out.
              <p className="text-meta leading-[1.45] text-muted-foreground">
                Covan has no OAuth application for this one, and it needs a sign-in. Somebody has to
                register a client with {toolkit.name} and paste it into Composio&rsquo;s dashboard
                before it can be connected here.
              </p>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * What the chip says about signing in.
 *
 * Read off the two flags `canConnectToolkit` reads, never off `authSchemes` —
 * `OAUTH2` is Composio's vocabulary and means nothing to the person deciding.
 */
function authLabel(toolkit: ComposioToolkit): string {
  if (toolkit.noAuth) return "No sign-in needed";
  if (toolkit.managedAuth) return `Sign in at ${toolkit.name}`;
  return "Needs setup in Composio";
}

type OperationsState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "ok";
      operations: {
        slug: string;
        name: string;
        description: string;
        destructive: boolean | null;
      }[];
      more: boolean;
    };

/**
 * What the application can actually do.
 *
 * The heading carries no number. "The first five operations" is backed by five
 * rows on screen and still reads as a claim about the application, and the
 * application's real total is the thing nothing here knows. The chip above
 * carries a count only when the route could earn one — see the note at the top.
 *
 * Rows rather than `DataRow`: that primitive renders `text-base` titles at
 * `px-4 py-3.5`, and ten of those is a dialog that scrolls before it says
 * anything. This is `ToolList`'s arrangement — square bullet, mono slug,
 * neutral chip, `text-meta` description — which already does exactly this job
 * for a connected service. `ToolList` itself is not reused: it takes a
 * different type and wraps itself in a `Disclosure`, and merging the two shapes
 * would make both worse.
 */
function Operations({ state }: { state: OperationsState }) {
  if (state.kind === "loading") {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (state.kind === "unavailable") {
    // Deliberately says nothing about how many operations exist. Connect is
    // still live above — nobody should be stopped from connecting Gmail
    // because a catalogue read wobbled.
    return (
      <p className="text-sm text-muted-foreground">Its operations could not be read just now.</p>
    );
  }
  if (state.operations.length === 0) {
    // "Read, and there are none" — a different fact from the line above, and
    // the reason the wire type distinguishes `[]` from `null`.
    return (
      <p className="text-sm text-muted-foreground">
        Composio lists no operations for this application.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* No number in the heading, deliberately. "The first 5 operations" is
          backed by five rows and still reads as a claim about the application —
          and the application's actual total is the thing nothing here knows.
          The chip above carries a count only when the route could earn one. */}
      <span className="text-xs uppercase tracking-[0.06em] text-muted-foreground">
        {state.more ? "Some of what it can do" : "What it can do"}
      </span>
      <ul className="flex flex-col gap-2.5">
        {state.operations.map((operation) => (
          <li key={operation.slug} className="flex items-start gap-2.5">
            {/* Square, per DESIGN.md. Circles are window chrome and nothing else. */}
            <span className="mt-[6px] h-2 w-2 shrink-0 rounded-[2px] bg-foreground" />
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs [overflow-wrap:anywhere]">{operation.slug}</span>
                {/* Only on `true`. `null` means Composio annotated nothing,
                    which is not the same as "safe" and must not read as it. */}
                {operation.destructive === true ? (
                  <Chip tone="neutral">Can change things</Chip>
                ) : null}
              </span>
              {operation.description ? (
                <span className="text-meta leading-[1.45] text-muted-foreground">
                  {operation.description}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

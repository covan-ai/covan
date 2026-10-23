import { toast } from "sonner";

import { lookup, msg, useTranslation, type TFunction } from "@/i18n";
import { assetSrc } from "@/lib/api-client";
import {
  canConnectToolkit,
  type ComposioConnectKind,
  type ComposioToolkit,
} from "@/lib/connections-api";
import { useComposioToolkitDetail, useConnectComposio } from "@/hooks/use-connections";
import { AppLogo } from "@/components/integrations/app-logo";
import { Chip } from "@/components/chip";
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
  const { t } = useTranslation();
  // Keyed off the toolkit rather than a separate `open`, so there is one source
  // of truth for "is a card showing" and it is the same value the card renders.
  const detail = useComposioToolkitDetail(toolkit?.slug ?? null);
  const connect = useConnectComposio();
  /**
   * The row the card decides from.
   *
   * The detail read is preferred because only it carries what connecting
   * requires in full — a list row can prove no-sign-in and managed OAuth and
   * is silent about the rest. The list row is the fallback, and that fallback
   * is what keeps Gmail's Connect button from waiting on a second request: its
   * answer was already in the grid.
   */
  const described = detail.data?.toolkit ?? toolkit;
  const kind: ComposioConnectKind | null = described?.connectKind ?? null;
  const connectable = described ? canConnectToolkit(described) : false;
  /**
   * Whether the card is still finding out.
   *
   * Only reachable for an application whose list row could not say — so never
   * for the hundred and twenty-three that connect today. This deliberately
   * differs from `Operations` below, which shows Connect anyway when its read
   * fails: nobody should be stopped from connecting Gmail because a catalogue
   * read wobbled. Here the read is not decoration — without it there is no way
   * to name the thing somebody is being asked to go and fetch, and offering a
   * button that cannot say what it wants is worse than saying so.
   */
  const checking = kind === null && detail.isPending;
  const credential = credentialNoun(t, described?.credentialScheme);

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
              {toolkit.description || t("Composio publishes no description for this application.")}
            </DialogDescription>

            <div className="flex flex-wrap items-center gap-1.5">
              {/* No chip at all while the answer is unknown — a guess here is
                  the thing this whole change exists to stop. */}
              {described && kind ? <Chip tone="neutral">{authLabel(t, described)}</Chip> : null}
              {/* Only when the route could back it. See the note at the top. */}
              {detail.data?.total != null ? (
                <Chip tone="neutral">
                  {t("{{count}} operation", {
                    count: detail.data.total,
                    defaultValue_other: "{{count}} operations",
                  })}
                </Chip>
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

          <DialogFooter className="shrink-0 flex-col items-stretch gap-2.5 border-t border-hairline px-5 py-4 sm:flex-col sm:items-stretch">
            {checking ? (
              <p className="text-meta leading-[1.45] text-muted-foreground">
                {t("Checking what this one needs…")}
              </p>
            ) : connectable ? (
              <>
                {kind === "user_credential" ? (
                  // Named before the button, not after it. Covan is about to
                  // send somebody to a third party to type a secret, and which
                  // third party that is belongs above the thing they press.
                  <p className="text-meta leading-[1.45] text-muted-foreground">
                    <strong className="font-medium text-foreground">
                      {t("Connect opens a page at Composio.")}
                    </strong>{" "}
                    {t(
                      "You enter your {{app}} {{credential}} there; Covan never sees it — the credential stays at Composio, and what is stored here is a reference to it. The page expires about ten minutes after you open it, so have the {{credential}} to hand.",
                      { app: toolkit.name, credential },
                    )}
                    {described?.authHintUrl ? (
                      <>
                        {" "}
                        <a
                          href={described.authHintUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          {t("Where to find it at {{app}}", { app: toolkit.name })}
                        </a>
                      </>
                    ) : null}
                  </p>
                ) : kind === "no_auth" ? (
                  // The one kind where pressing Connect opens nothing at all.
                  // Said out loud because the button is otherwise identical to
                  // the two that hand the browser to a third party, and a
                  // person who expects a consent screen and gets a row is
                  // entitled to wonder whether it worked.
                  <p className="text-meta leading-[1.45] text-muted-foreground">
                    <strong className="font-medium text-foreground">
                      {t("There is nothing to sign in to.")}
                    </strong>{" "}
                    {t(
                      "{{app}} needs no account and no key, so Connect adds it here and nothing leaves this page. Your agents can call it straight away.",
                      { app: toolkit.name },
                    )}
                  </p>
                ) : null}
                <div className="flex justify-end">
                  <Button
                    disabled={connect.isPending}
                    onClick={() =>
                      connect.mutate(
                        {
                          toolkit: toolkit.slug,
                          label: toolkit.name,
                          // Only a no-sign-in application legitimately comes
                          // back with nowhere to go. Anything else that does
                          // is a bug, and this is what makes it a toast
                          // rather than a button that un-disables and does
                          // nothing.
                          expectRedirect: kind !== "no_auth",
                        },
                        { onError: (err: Error) => toast.error(err.message) },
                      )
                    }
                  >
                    {connect.isPending ? t("Opening…") : t("Connect")}
                  </Button>
                </div>
              </>
            ) : (
              // No button at all rather than a disabled one. The thing standing
              // in the way is a job somebody has to do in Composio's dashboard,
              // not a state this page is waiting out. Said generically because
              // it is not always an OAuth client — some of these want a machine
              // client, and ninety-five want something Composio documents
              // nowhere.
              <p className="text-meta leading-[1.45] text-muted-foreground">
                {kind === null
                  ? t("Covan could not check what {{app}} needs just now. Try again in a moment.", {
                      app: toolkit.name,
                    })
                  : t(
                      "{{app}} can’t be connected yet. It has to be set up in Composio, the service Covan connects apps through, before anyone here can sign in to it.",
                      { app: toolkit.name },
                    )}
              </p>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * The noun somebody is being asked to go and fetch.
 *
 * From Composio's scheme, and never Composio's word for it: telling a person
 * to paste an API key into something labelled `BASIC` is `DESIGN.md`'s opening
 * failure. The fallback is deliberately vague rather than wrong — three
 * applications in the catalogue ask for a client id and secret, and calling
 * that "a key" would send somebody looking for the wrong thing.
 */
const CREDENTIAL_NOUN: Record<string, string> = {
  API_KEY: msg("API key"),
  BEARER_TOKEN: msg("access token"),
  BASIC: msg("username and password"),
};

function credentialNoun(t: TFunction, scheme: string | undefined): string {
  // The scheme is Composio's ASCII identifier, not a word anybody reads.
  const key = CREDENTIAL_NOUN[(scheme ?? "").toUpperCase()]; // i18n-ignore
  return key ? lookup(t, key) : t("credential");
}

/**
 * What the chip says about signing in.
 *
 * Read off `connectKind`, never off `authSchemes` — `OAUTH2` is Composio's
 * vocabulary and means nothing to the person deciding. The scheme is consulted
 * only to pick the noun, and each noun is a whole sentence here rather than a
 * word with an article in front of it: "an username" is a rule about spelling
 * pretending to be a rule about pronunciation, and other languages have no
 * article to get wrong.
 */
function authLabel(t: TFunction, toolkit: ComposioToolkit): string {
  const app = toolkit.name;
  switch (toolkit.connectKind) {
    case "no_auth":
      return t("No sign-in needed");
    case "managed_oauth":
      return t("Sign in at {{app}}", { app });
    case "user_credential": {
      switch (
        (toolkit.credentialScheme ?? "").toUpperCase() // i18n-ignore
      ) {
        case "API_KEY":
          return t("Needs an API key from {{app}}", { app });
        case "BEARER_TOKEN":
          return t("Needs an access token from {{app}}", { app });
        case "BASIC":
          return t("Needs a username and password from {{app}}", { app });
        default:
          return t("Needs a credential from {{app}}", { app });
      }
    }
    // The person reading this does not know what Composio is, and does not
    // need to in order to learn that this one is not available. The footer
    // says why, for whoever does want to know (covan-cloud#407).
    default:
      return t("Not available yet");
  }
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
  const { t } = useTranslation();
  if (state.kind === "loading") {
    return <p className="text-sm text-muted-foreground">{t("Loading…")}</p>;
  }
  if (state.kind === "unavailable") {
    // Deliberately says nothing about how many operations exist. Connect is
    // still live above — nobody should be stopped from connecting Gmail
    // because a catalogue read wobbled.
    return (
      <p className="text-sm text-muted-foreground">
        {t("Its operations could not be read just now.")}
      </p>
    );
  }
  if (state.operations.length === 0) {
    // "Read, and there are none" — a different fact from the line above, and
    // the reason the wire type distinguishes `[]` from `null`.
    return (
      <p className="text-sm text-muted-foreground">
        {t("Composio lists no operations for this application.")}
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
        {state.more ? t("Some of what it can do") : t("What it can do")}
      </span>
      <ul className="flex flex-col gap-2.5">
        {state.operations.map((operation) => (
          <li key={operation.slug} className="flex items-start gap-2.5">
            {/* Square, per DESIGN.md. Circles are window chrome and nothing else. */}
            <span className="mt-[6px] h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="flex flex-wrap items-center gap-1.5">
                {/* Composio's display name, not its slug. `GMAIL_SEND_EMAIL`
                    is an identifier for a program; the person deciding whether
                    to connect Gmail reads "Send email" (covan-cloud#407). The
                    route falls back to the slug when there is no name. */}
                <span className="text-sm font-medium [overflow-wrap:anywhere]">
                  {operation.name || operation.slug}
                </span>
                {/* Only on `true`. `null` means Composio annotated nothing,
                    which is not the same as "safe" and must not read as it. */}
                {operation.destructive === true ? (
                  <Chip tone="neutral">{t("Can change things")}</Chip>
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

import { Trans, useTranslation } from "@/i18n";
import { RevealedSecret } from "@/components/revealed-secret";
import { useRoutineEventSetup } from "@/hooks/use-routines";

/**
 * How to pair a chat with a Telegram routine, on its page.
 *
 * Nothing runs for a message to the bot until the chat it came from has
 * opened this link, which sends the bot `/start` with this routine's code.
 * The link stays on the page, because a second chat — a team group — pairs
 * the same way, and the chats already paired are listed under it so the
 * owner can see who can start the routine.
 */
export function TelegramBotSetup({ routineId }: { routineId: string }) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useRoutineEventSetup(routineId, true);

  if (isPending) return <p className="text-meta text-muted-foreground">{t("Loading the bot…")}</p>;
  if (isError) {
    return (
      <p className="text-meta text-muted-foreground">
        {t("Couldn't load the bot. Reload to try again.")}
      </p>
    );
  }
  if (data.kind !== "telegram") return null;

  return (
    <div className="space-y-3 rounded-lg border border-hairline p-4">
      <p className="text-sm">{t("Pair a chat with @{{bot}}", { bot: data.botUsername })}</p>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        <li>{t("Open the link below on a phone or computer with Telegram, and press Start.")}</li>
        <li>
          <Trans
            t={t}
            i18nKey="For a group, add @{{bot}} to the group first, then send the bot <code>/start {{code}}</code> in the group."
            values={{ bot: data.botUsername, code: data.code }}
            components={{ code: <code className="font-mono" /> }}
          />
        </li>
        <li>
          {t("Messages in a paired chat start the routine, and its answer comes back there.")}
        </li>
      </ol>
      <RevealedSecret value={data.link} label={t("Copy pairing link")} />
      <p className="text-meta text-muted-foreground">
        {data.chats.length === 0
          ? t("No chat is paired yet, so nothing can start this routine from Telegram.")
          : t("Paired: {{chats}}.", { chats: data.chats.join(", ") })}
      </p>
    </div>
  );
}

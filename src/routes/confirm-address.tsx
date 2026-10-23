import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "@/i18n";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";

/**
 * Where a "confirm this address" email lands: `/confirm-address#token=…`.
 *
 * Somebody using Covan asked to send routine results to an address that is not
 * their own sign-in address, and nothing goes there until the address says yes
 * (migration 0096). Whoever reads that mailbox may have no Covan account, so
 * this page needs no session: the token from the email is the whole of it.
 *
 * Confirming is a button, never the visit. Mail scanners open links, and a
 * link that confirmed on opening would confirm every address behind a scanner
 * — the people least likely to have asked. The token leaves the address bar
 * as soon as it is read, for `/invite`'s reasons: history, screenshots, the
 * URL somebody copies to ask for help.
 */
export const Route = createFileRoute("/confirm-address")({
  component: ConfirmAddress,
});

type Status = "checking" | "ready" | "no-link" | "confirming" | "confirmed" | "failed";

function tokenFromFragment(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token && token.length >= 16 ? token : null;
}

function ConfirmAddress() {
  const { t } = useTranslation();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    const found = tokenFromFragment(window.location.hash);
    if (found) window.history.replaceState(null, "", window.location.pathname);
    // Once, on mount, from something only the browser has: the fragment never
    // reaches a server render, so it cannot be initial state without the two
    // renders disagreeing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(found);
    setStatus(found ? "ready" : "no-link");
  }, []);

  const confirm = async () => {
    if (!token) return;
    setStatus("confirming");
    try {
      await api.addressConfirmations.confirm(token);
      setStatus("confirmed");
    } catch {
      setStatus("failed");
    }
  };

  if (status === "checking") {
    return (
      <AuthLayout title={t("Confirm this address")} subtitle={t("One moment.")}>
        <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
          {t("Loading…")}
        </div>
      </AuthLayout>
    );
  }

  if (status === "no-link" || status === "failed") {
    return (
      <AuthLayout
        title={status === "failed" ? t("That link no longer works") : t("That link is incomplete")}
        subtitle={
          status === "failed"
            ? t("It may have been used already, or it is more than a week old.")
            : t("Open the button in the email again.")
        }
      >
        <p className="m-0 text-sm text-muted-foreground">
          {t(
            "Nothing will be sent to this address unless it is confirmed. If you expected these messages, ask whoever set them up to send a new link.",
          )}
        </p>
      </AuthLayout>
    );
  }

  if (status === "confirmed") {
    return (
      <AuthLayout
        title={t("Address confirmed")}
        subtitle={t("Routine results can now be sent here.")}
      >
        <p className="m-0 text-sm text-muted-foreground">
          {t(
            "You can close this page. To stop them later, reply to the person who set them up, or ask them to remove this address.",
          )}
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t("Confirm this address")}
      subtitle={t("Somebody using Covan asked to send routine results here.")}
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm text-muted-foreground">
          {t(
            "If that was you, or you expect them, confirm below. If not, close this page — nothing is sent here unless you do.",
          )}
        </p>
        <Button
          size="lg"
          className="w-full"
          onClick={() => void confirm()}
          disabled={status === "confirming"}
        >
          {status === "confirming" ? t("Confirming…") : t("Confirm this address")}
        </Button>
      </div>
    </AuthLayout>
  );
}

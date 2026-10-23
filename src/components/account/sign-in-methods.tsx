import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { Field } from "@/components/field";
import { Tile } from "@/components/tile";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { enabledProviders, type OAuthProvider } from "@/lib/supabase/providers";

/** Brand names, the same in every language. */
const LABEL: Record<OAuthProvider, string> = { google: "Google", github: "GitHub" };

/**
 * "Signed in with" (A16): each sign-in provider this install offers, with the
 * address it signs in as, and Connect or Disconnect. Connecting goes round
 * the provider and back here; the account must keep at least one way in, so
 * the last one cannot be disconnected.
 */
export function SignInMethods() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: identities = [] } = useQuery({
    queryKey: ["account", "identities"],
    queryFn: () => api.account.identities(),
  });
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [busy, setBusy] = useState<OAuthProvider | null>(null);

  useEffect(() => {
    let active = true;
    void enabledProviders().then((found) => {
      if (active) setProviders(found);
    });
    return () => {
      active = false;
    };
  }, []);

  if (providers.length === 0) return null;

  const connect = async (provider: OAuthProvider) => {
    setBusy(provider);
    const { error } = await supabase.auth.linkIdentity({
      provider,
      options: { redirectTo: `${window.location.origin}/settings/profile` },
    });
    // On success the browser leaves for the provider.
    if (error) {
      toast.error(error.message);
      setBusy(null);
    }
  };

  const disconnect = async (provider: OAuthProvider) => {
    setBusy(provider);
    try {
      const { data, error } = await supabase.auth.getUserIdentities();
      if (error) throw error;
      const identity = data?.identities.find((i) => i.provider === provider);
      if (!identity) throw new Error(t("That sign-in is already gone"));
      const { error: unlinkError } = await supabase.auth.unlinkIdentity(identity);
      if (unlinkError) throw unlinkError;
      await queryClient.invalidateQueries({ queryKey: ["account", "identities"] });
      toast.success(t("{{provider}} disconnected", { provider: LABEL[provider] }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Couldn't disconnect that"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Field label={t("Signed in with")} help={t("Connected sign-in providers.")}>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {providers.map((provider) => {
          const identity = identities.find((i) => i.provider === provider);
          const last = identity !== undefined && identities.length <= 1;
          return (
            <li key={provider} className="flex min-h-8 items-center gap-2.5 text-sm">
              <Tile label={LABEL[provider]} size={24} className="rounded-full" />
              <span>{LABEL[provider]}</span>
              <span className="min-w-0 truncate text-meta text-muted-foreground">
                {identity ? (identity.email ?? t("connected")) : t("not connected")}
              </span>
              {identity ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  disabled={busy !== null || last}
                  title={last ? t("Your only way in — add another first") : undefined}
                  onClick={() => void disconnect(provider)}
                >
                  {t("Disconnect")}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  disabled={busy !== null}
                  onClick={() => void connect(provider)}
                >
                  {busy === provider ? t("Redirecting…") : t("Connect")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Field>
  );
}

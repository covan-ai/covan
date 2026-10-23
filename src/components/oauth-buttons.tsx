import { useEffect, useState, type ReactElement } from "react";
import { Trans, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { LegalAnchor } from "@/components/legal-anchor";
import { supabase } from "@/lib/supabase/client";
import { setRemember } from "@/lib/supabase/auth-storage";
import { enabledProviders, type OAuthProvider } from "@/lib/supabase/providers";
import { privacyLink, termsLink } from "@/lib/legal";

type MarkProps = { className?: string };

/** Google's "G", in its own four colours — the mark its sign-in guidelines ask for. */
function GoogleMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** GitHub's Octocat. Monochrome, so `currentColor`, and it inverts with the theme. */
function GitHubMark({ className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const PROVIDER: Record<OAuthProvider, { label: string; Mark: (props: MarkProps) => ReactElement }> =
  {
    google: { label: "Google", Mark: GoogleMark },
    github: { label: "GitHub", Mark: GitHubMark },
  };

/**
 * "Continue with Google" and "Continue with GitHub", above the email form on
 * both doors — and nothing at all on an install that has neither switched on.
 *
 * One component for both pages because there is only one action behind it. A
 * provider does not distinguish signing in from signing up: the first click
 * from a new address creates the account, and every click after that signs it
 * in. Which is also why the agreement line sits under these buttons on the
 * sign-in page too — that page creates accounts now, and the sign-up form's
 * checkbox is not on it.
 *
 * The round trip lands on `/auth/callback`, which finishes it; see there.
 */
export function OAuthButtons({
  remember,
  onError,
  consent = true,
}: {
  /**
   * Settled before leaving, for the reason sign-in settles it before the
   * password call: the session is written the moment the browser comes back,
   * by supabase-js reading it out of the URL, before any route has mounted.
   * The flag lives in sessionStorage, which the same tab keeps across the trip.
   */
  remember: boolean;
  onError: (message: string) => void;
  /**
   * The sentence that continuing agrees to the Terms. On by default: a
   * provider's sign-in can make an account on any page that offers it, so a
   * page leaves it out only where the card already says it (sign-up).
   */
  consent?: boolean;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [leaving, setLeaving] = useState<OAuthProvider | null>(null);

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

  async function start(provider: OAuthProvider) {
    setLeaving(provider);
    setRemember(remember);
    // On success this navigates away and the promise never matters. An error
    // here is one supabase-js raised before leaving; GoTrue's own refusals come
    // back to `/auth/callback` in the URL.
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setLeaving(null);
      onError(error.message);
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-2">
        {providers.map((provider) => {
          const { label, Mark } = PROVIDER[provider];
          return (
            <Button
              key={provider}
              type="button"
              variant="secondary"
              size="lg"
              className="w-full gap-2.5"
              disabled={leaving !== null}
              onClick={() => void start(provider)}
            >
              <Mark className="!size-[18px]" />
              {leaving === provider
                ? t("Redirecting…")
                : t("Continue with {{provider}}", { provider: label })}
            </Button>
          );
        })}
      </div>

      {consent ? (
        <p className="mt-3 mb-0 text-meta leading-[1.5] text-muted-foreground">
          <Trans
            t={t}
            i18nKey="Continuing with {{providers}} agrees to the <terms>Terms</terms> and the <privacy>Privacy policy</privacy>."
            values={{
              providers: new Intl.ListFormat(locale, { type: "disjunction" }).format(
                providers.map((p) => PROVIDER[p].label),
              ),
            }}
            components={{
              terms: (
                <LegalAnchor link={termsLink()} newTab>
                  {null}
                </LegalAnchor>
              ),
              privacy: (
                <LegalAnchor link={privacyLink()} newTab>
                  {null}
                </LegalAnchor>
              ),
            }}
          />
        </p>
      ) : null}

      <div className="my-5 flex items-center gap-3 text-xs text-micro-foreground">
        <span className="h-px flex-1 bg-hairline" />
        {t("or")}
        <span className="h-px flex-1 bg-hairline" />
      </div>
    </div>
  );
}

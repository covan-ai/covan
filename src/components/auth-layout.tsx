import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandLockup } from "@/components/brand-mark";
import { LegalAnchor } from "@/components/legal-anchor";
import { privacyLink, statusLink, termsLink } from "@/lib/legal";
import { cn } from "@/lib/utils";

/**
 * Every signed-out page (A11, A23, A30): the grey canvas, the Covan lockup,
 * one 400px white card with its title on the left and a sentence under it,
 * a line under the card, and Terms · Privacy (· Status) at the foot.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /** The line under the card: "New here? Create a workspace". */
  footer?: ReactNode;
  className?: string;
}) {
  const status = statusLink();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-sidebar px-4 py-10">
      <Link to="/" aria-label="Covan">
        <BrandLockup />
      </Link>

      <div
        className={cn(
          "w-full max-w-[400px] rounded-2xl border border-border bg-card px-7 pt-7 pb-6 shadow-xs",
          className,
        )}
      >
        <h1 className="m-0 text-title-lg font-semibold">{title}</h1>
        {subtitle ? <p className="mt-1 mb-5 text-sm text-muted-foreground">{subtitle}</p> : null}
        <div className={subtitle ? undefined : "mt-5"}>{children}</div>
      </div>

      {footer ? <p className="m-0 text-sm text-muted-foreground">{footer}</p> : null}

      <p className="m-0 flex gap-4 text-xs text-micro-foreground">
        <LegalAnchor link={termsLink()} variant="plain">
          Terms
        </LegalAnchor>
        <LegalAnchor link={privacyLink()} variant="plain">
          Privacy
        </LegalAnchor>
        {status ? (
          <LegalAnchor link={status} variant="plain" newTab>
            Status
          </LegalAnchor>
        ) : null}
      </p>
    </div>
  );
}

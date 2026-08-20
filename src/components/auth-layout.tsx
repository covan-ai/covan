import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-hero-glow px-4 py-12">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2">
          <BrandMark className="shadow-glow" />
          <span className="text-sm font-semibold tracking-tight">Covan</span>
        </Link>

        <div className="rounded-2xl border border-hairline bg-card p-7 shadow-elegant">
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <div className="mt-6">{children}</div>
        </div>

        {footer && <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>}
      </div>
    </div>
  );
}

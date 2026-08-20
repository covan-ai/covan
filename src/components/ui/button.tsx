import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/*
 * The button, per the design system §6.
 *
 * A prominent button is an ink (or, in dark, paper) fill carrying a 36px amber
 * CHIP with a sliding chevron, beside a label roller holding two stacked copies
 * of the text. On hover the chevron slides in from the left and the label rolls
 * up to its duplicate, both over 400ms on the spring curve. The chip is amber
 * in both variants — that is what ties a raised secondary button to an ink
 * primary one.
 *
 * Extension: the system says there is no small, icon-only, or destructive
 * variant, because a marketing page has none of those actions. An application
 * does. So the roller is reserved for full-size `default` / `secondary`
 * buttons (the real CTAs) and the quiet variants — outline, ghost, link,
 * destructive, and every non-default size — render as plain on-system buttons.
 * `asChild` also renders plain: the chip cannot be injected into an arbitrary
 * child element without Slottable, and every current call site is `outline`.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors duration-200 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground border border-border hover:bg-accent",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/** The asymmetric padding is the point: the chip sits flush against the left edge. */
const rollerShell = "gap-3 p-1 pr-3";

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9.5 6.5 15 12l-5.5 5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The chip and the roller. Both duplicated elements are real and required: two
 * chevrons so one slides in as the other slides out, two labels so the roller
 * has somewhere to roll. The second copy of each is aria-hidden so a screen
 * reader announces the label once.
 */
function RollerContent({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-accent-orange">
        {/* A 25px window over two 24px chevrons, resting shifted left by 23px
            so the second chevron is the one visible before hover. */}
        <span className="inline-flex h-6 w-[25px] items-center overflow-hidden text-[#251f19]">
          <span className="inline-flex -translate-x-[23px] transition-transform duration-[400ms] ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0 [&_svg]:size-6">
            <Chevron />
            <Chevron />
          </span>
        </span>
      </span>
      <span className="inline-flex h-[18px] flex-col overflow-hidden">
        <span className="flex h-[18px] shrink-0 items-center gap-2 leading-[18px] opacity-90 transition-transform duration-[400ms] ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-[18px]">
          {children}
        </span>
        <span
          aria-hidden="true"
          className="flex h-[18px] shrink-0 items-center gap-2 leading-[18px] opacity-90 transition-transform duration-[400ms] ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-[18px]"
        >
          {children}
        </span>
      </span>
    </>
  );
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const rolls =
      !asChild &&
      (variant ?? "default") !== "link" &&
      (size ?? "default") === "default" &&
      ((variant ?? "default") === "default" || variant === "secondary");

    return (
      <Comp
        className={cn(
          buttonVariants({ variant, size }),
          rolls && `group h-11 ${rollerShell}`,
          className,
        )}
        ref={ref}
        {...props}
      >
        {rolls ? <RollerContent>{children}</RollerContent> : children}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };

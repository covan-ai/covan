import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/*
 * The button, per DESIGN.md §4.
 *
 * 32px, a 6px radius, a 14px medium label, and nothing inside it that moves.
 * `default` is the ink fill and the one button a screen leads with;
 * `secondary` is white with the input border; `ghost` is the quiet one for
 * toolbars and rows; `danger` is red text on white, for the confirming
 * action of something that cannot be taken back. `lg` (36px) is for the auth
 * cards alone.
 *
 * There used to be a 36px amber chip with a sliding chevron and a two-line
 * label roller in here. It was a marketing flourish and it made every call
 * to action look like a toy; it is gone, and nothing else in the app knew it
 * existed.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground border border-primary hover:bg-primary/90",
        // Red text on a white button: a destructive action is never a red fill.
        danger: "border border-input bg-card text-destructive hover:bg-surface-muted",
        secondary: "border border-input bg-card text-foreground hover:bg-surface-muted",
        ghost: "text-muted-foreground hover:bg-surface hover:text-foreground",
        link: "h-auto px-0 text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2.5 text-meta",
        lg: "h-9 px-4",
        icon: "size-8",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };

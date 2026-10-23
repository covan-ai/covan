"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "@/i18n";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/** One box: white, 12px radius, the border, the floating shadow (DESIGN.md §10). */
const BOX_CLASS =
  "fixed left-[50%] top-[50%] z-50 flex w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col gap-3.5 rounded-2xl border border-border bg-popover p-5 shadow-card duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 max-h-[calc(100dvh-2rem)] overflow-y-auto";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

/** The close button's name for a screen reader, in the page's language. */
function CloseLabel() {
  const { t } = useTranslation();
  return <span className="sr-only">{t("Close")}</span>;
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/** A dialog's width (DESIGN.md §10): 420, 520 or 640, full width on a phone. */
const DIALOG_WIDTH = { sm: "max-w-[420px]", md: "max-w-[520px]", lg: "max-w-[640px]" } as const;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    size?: keyof typeof DIALOG_WIDTH;
    /** For a box that says `esc` instead (the ⌘K palette). */
    hideClose?: boolean;
  }
>(({ className, children, size = "md", hideClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(BOX_CLASS, DIALOG_WIDTH[size], className)}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute top-3.5 right-3.5 grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none">
          <X className="size-4" />
          <CloseLabel />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1 pr-8 text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

/** The middle of a dialog: 14px text, 14px between blocks. */
const DialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-3.5 text-sm", className)} {...props} />
);
DialogBody.displayName = "DialogBody";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 pt-1.5 sm:flex-row sm:items-center sm:justify-end",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("flex items-center gap-2.5 text-title-lg font-semibold", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogBody,
};

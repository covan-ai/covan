import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    // Ink with white text, bottom right (DESIGN.md §11); an error is white
    // with its word in red. An undo rides in the toast that announced it.
    <Sonner
      className="toaster group"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast rounded-lg! border! text-sm! group-[.toaster]:bg-primary group-[.toaster]:text-primary-foreground group-[.toaster]:border-primary group-[.toaster]:shadow-card",
          error:
            "group-[.toaster]:bg-card! group-[.toaster]:text-foreground! group-[.toaster]:border-border! [&_[data-icon]]:text-destructive [&_[data-title]]:text-destructive",
          description: "group-[.toast]:text-primary-foreground/75",
          actionButton:
            "group-[.toast]:bg-transparent! group-[.toast]:text-primary-foreground! group-[.toast]:font-medium group-[.toast]:underline",
          cancelButton: "group-[.toast]:bg-transparent! group-[.toast]:text-primary-foreground/75!",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };

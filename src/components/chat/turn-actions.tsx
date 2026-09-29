import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The two icon buttons the chat screen is made of, at the two sizes it uses
 * them.
 *
 * One file, deliberately. `HeaderAction`'s own comment defines it as the same
 * object as `MsgAction` one step up the ladder, and a definition like that is
 * only true while somebody can see both. In separate modules they drift: one
 * grows a `disabled`, the other a `variant`, and the sentence becomes a claim
 * about a file nobody has open.
 */

/**
 * An action on one message. 28px, in a strip under a reply.
 */
export function MsgAction({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-accent",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * A control in the conversation header.
 *
 * The same object as `MsgAction` one step up the ladder: 36px rather than 28px,
 * because it sits in a 56px bar and not in a hover strip, and because a header
 * control is a target you reach for deliberately.
 */
export function HeaderAction({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "grid h-9 w-9 place-items-center rounded-md transition-colors duration-200 hover:bg-accent",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

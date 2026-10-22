import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * Six boxes for a one-time code (A23), and one hidden input carrying the
 * digits under `name` so the form around it reads it like any other field.
 *
 * Typing moves to the next box, Backspace on an empty box to the one before,
 * and a pasted or autofilled code — "123 456" as people read it aloud — fills
 * every box at once.
 */
export function CodeInput({
  value,
  onChange,
  name,
  disabled,
  length = 6,
  label = "Six-digit code",
}: {
  value: string;
  onChange: (digits: string) => void;
  name: string;
  disabled?: boolean;
  length?: number;
  label?: string;
}) {
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const digits = value.replace(/\D/g, "").slice(0, length);

  const put = (from: number, typed: string) => {
    const incoming = typed.replace(/\D/g, "");
    if (!incoming) return;
    const next = (digits.slice(0, from) + incoming).slice(0, length);
    onChange(next);
    boxes.current[Math.min(next.length, length - 1)]?.focus();
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (digits[i]) onChange(digits.slice(0, i) + digits.slice(i + 1));
      else if (i > 0) {
        onChange(digits.slice(0, i - 1));
        boxes.current[i - 1]?.focus();
      }
    } else if (e.key === "ArrowLeft" && i > 0) boxes.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < length - 1) boxes.current[i + 1]?.focus();
  };

  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    put(i, e.clipboardData.getData("text"));
  };

  return (
    <div role="group" aria-label={label} className="flex justify-between gap-2">
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          aria-label={`Digit ${i + 1}`}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          disabled={disabled}
          value={digits[i] ?? ""}
          onChange={(e) => put(i, e.target.value.slice(-length))}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={(e) => onPaste(i, e)}
          onFocus={(e) => e.target.select()}
          className={cn(
            "h-12 w-11 rounded-md border border-input bg-card text-center text-xl font-semibold tabular-nums outline-none",
            "focus:border-foreground focus:outline-2 focus:outline-offset-2 focus:outline-ring disabled:opacity-50",
          )}
        />
      ))}
      <input type="hidden" name={name} value={digits} />
    </div>
  );
}

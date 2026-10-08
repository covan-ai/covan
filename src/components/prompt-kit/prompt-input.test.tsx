import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from "./prompt-input";

/**
 * The copied composer, tested where the copy was edited.
 *
 * This file exists because the drift risk is the whole problem with a copied
 * component: the next person re-copies upstream, the header's four edits go,
 * and nothing fails. These are the edits, as assertions.
 */

function Composer({ onSubmit }: { onSubmit?: () => void } = {}) {
  return (
    <PromptInput value="" onValueChange={() => {}} onSubmit={onSubmit}>
      <PromptInputTextarea placeholder="Message" />
      <PromptInputActions>
        <button type="button" aria-label="Attach">
          clip
        </button>
        <PromptInputAction tooltip="Send it">
          <button type="button" aria-label="Send" disabled>
            go
          </button>
        </PromptInputAction>
      </PromptInputActions>
    </PromptInput>
  );
}

describe("the composer's container", () => {
  it("focuses the textarea when you click the padding", async () => {
    render(<Composer />);
    await userEvent.click(screen.getByPlaceholderText("Message").parentElement!);
    expect(screen.getByPlaceholderText("Message")).toHaveFocus();
  });

  it("leaves the textarea alone when you click a control inside it", async () => {
    /*
     * The composer used to be a plain `<div>`. `PromptInput` focuses the
     * textarea on ANY click inside itself, and only `PromptInputAction` stops
     * propagation — which wraps send and stop alone. So attach, report, mic,
     * a receipt's dismiss and the bundle popover that lives inside this
     * container all raised the virtual keyboard over the content on a phone,
     * which is the mobile half of failure mode #5 arriving by the back door.
     */
    render(<Composer />);
    await userEvent.click(screen.getByLabelText("Attach"));
    expect(screen.getByPlaceholderText("Message")).not.toHaveFocus();
  });
});

describe("a wrapped action", () => {
  it("does not hang its tooltip on an element a browser will not point at", () => {
    /*
     * A disabled button receives no pointer events in any browser, so Radix's
     * trigger never fires on it — and the send button is disabled in exactly
     * the state whose tooltip is worth reading ("waiting for the current reply
     * to finish"). The `title` this replaced did render there, because browser
     * chrome draws it. So the trigger has to be something enabled around the
     * button.
     */
    render(<Composer />);
    const button = screen.getByLabelText("Send");

    expect(button).toBeDisabled();
    // Radix marks its own trigger with `data-state`.
    expect(button).not.toHaveAttribute("data-state");
    expect(button.parentElement).toHaveAttribute("data-state");
  });
});

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const MAX = 4000;

/**
 * The other door.
 *
 * Only the message is sent. Who is asking, how big their workspace is and how
 * much they have spent are read by the API from its own tables — partly because
 * a caller who could name their own seat count could name a hundred, and partly
 * because asking somebody at a wall to fill in a form about themselves is a way
 * of not hearing from them.
 *
 * A failure is shown rather than swallowed. This is the moment somebody decides
 * whether the product is worth paying for, and a message that quietly did not
 * arrive is worse than one that was refused.
 */
export function QuotaSupportForm() {
  const [message, setMessage] = useState("");
  const send = useMutation({
    mutationFn: () => api.support.quota(message.trim()),
  });

  if (send.isSuccess) {
    return (
      <p className="text-xs text-muted-foreground">Sent — we will read it and get back to you.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label="What do you need?"
        placeholder="What do you need? Roughly how much, and by when?"
        maxLength={MAX}
        rows={3}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      {send.isError && (
        // `--destructive`, not the amber accent: DESIGN.md reserves amber for a
        // pointer and keeps this one token for "an engine-level failure", which
        // is exactly what a send that did not arrive is.
        <p className="text-xs text-destructive">
          {send.error instanceof Error ? send.error.message : "Couldn't send that message"} — or
          email efe@covan.app directly.
        </p>
      )}
      <Button
        className="self-start"
        onClick={() => send.mutate()}
        disabled={message.trim().length === 0 || send.isPending}
      >
        Send
      </Button>
    </div>
  );
}

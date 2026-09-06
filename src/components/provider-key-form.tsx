import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * One provider's key, for an admin.
 *
 * Shows a hint when one is set and an input when one is not, and never the
 * other way round: there is no endpoint that returns a stored key, so there is
 * nothing to prefill an input with. Replacing means typing the whole thing
 * again, which is the honest consequence of not keeping it anywhere readable.
 */
export function ProviderKeyForm({
  provider,
  label,
  placeholder,
  hint,
}: {
  provider: "openai" | "anthropic";
  label: string;
  placeholder: string;
  hint: string | null;
}) {
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(false);
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["provider-keys"] });
    // The wall's own state depends on this too — a key that has just been set
    // is the difference between a refusal and a reply.
    void queryClient.invalidateQueries({ queryKey: ["usage"] });
  };

  const save = useMutation({
    mutationFn: () => api.providerKeys.set({ provider, key: value.trim() }),
    onSuccess: () => {
      setValue("");
      setReplacing(false);
      invalidate();
      toast.success(`${label} saved`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't save that key"),
  });

  const remove = useMutation({
    mutationFn: () => api.providerKeys.clear(provider),
    onSuccess: () => {
      invalidate();
      toast.success(`${label} removed`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't remove that key"),
  });

  if (hint && !replacing) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {label}: <span className="font-mono">{hint}</span>
        </span>
        <span className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            Remove
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`key-${provider}`} className="text-xs">
        {label}
      </Label>
      <div className="flex gap-2">
        <Input
          id={`key-${provider}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button onClick={() => save.mutate()} disabled={value.trim().length < 8 || save.isPending}>
          Save
        </Button>
      </div>
    </div>
  );
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api-client";
import { lastActivityLabel } from "@/lib/day-groups";

/**
 * Where you are signed in (A16): each browser as device · browser and when
 * it was last seen, this one first and marked, the rest with Sign out. No
 * place names: GoTrue keeps an address, and a guessed city would be one.
 */
export function SessionsList() {
  const queryClient = useQueryClient();
  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["account", "sessions"],
    queryFn: () => api.account.sessions(),
  });
  const [revoking, setRevoking] = useState<string | null>(null);

  const signOut = async (id: string) => {
    setRevoking(id);
    try {
      await api.account.revokeSession(id);
      await queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
      toast.success("Signed out of that browser");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't sign that browser out");
    } finally {
      setRevoking(null);
    }
  };

  const ordered = [...sessions].sort((a, b) => Number(b.current) - Number(a.current));

  return (
    <Field label="Sessions" help="Where you are signed in. Sign out of any you do not recognise.">
      {isLoading ? (
        <p className="pt-1.5 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="m-0 max-w-[560px] list-none p-0">
          {ordered.map((s) => (
            <li
              key={s.id}
              className="flex min-h-11 items-center gap-3 border-b border-hairline text-sm last:border-b-0"
            >
              <StatusDot
                state={s.current ? "done" : "idle"}
                className={s.current ? "bg-foreground" : ""}
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{s.current ? "This device" : s.device}</span>
                <span className="text-meta text-muted-foreground">
                  {" "}
                  · {s.current ? `${s.browser} on ${s.device}` : s.browser}
                </span>
              </span>
              <span className="shrink-0 text-meta text-muted-foreground">
                {s.current ? "Now" : s.lastSeenAt ? lastActivityLabel(s.lastSeenAt) : "—"}
              </span>
              {!s.current && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revoking !== null}
                  onClick={() => void signOut(s.id)}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

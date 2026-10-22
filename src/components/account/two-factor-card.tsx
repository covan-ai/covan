import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Smartphone } from "lucide-react";
import { toast } from "sonner";
import type { Factor } from "@supabase/supabase-js";
import { SectionCard, DataRow } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { formatRelative } from "@/lib/relative-time";
import {
  abandonEnrollment,
  confirmEnrollment,
  removeAuthenticator,
  startEnrollment,
  verifiedAuthenticators,
  type Enrollment,
} from "@/lib/supabase/mfa";

const QUERY_KEY = ["authenticators"];

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Two-step sign-in: a code from an authenticator app after the password.
 *
 * On as soon as one authenticator is confirmed, off when the last is removed —
 * there is no separate switch, because a switch that could be on with nothing
 * behind it would be a way to lock yourself out. What it protects is enforced
 * by the database and the API (0108, middleware/auth.ts), not by this page: a
 * session that has not given the code is refused everything.
 */
export function TwoFactorCard() {
  const {
    data: factors,
    isPending,
    isError,
  } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: verifiedAuthenticators,
  });
  const [adding, setAdding] = useState(false);
  const devices = factors ?? [];
  const on = devices.length > 0;

  return (
    <SectionCard className="mt-6 space-y-5">
      <div className="space-y-1">
        <div className="text-title font-medium">Two-step sign-in</div>
        <p className="text-meta text-muted-foreground">
          {on
            ? "On. Signing in asks for a code from one of these after your password."
            : "Ask for a code from an authenticator app — 1Password, Google Authenticator, Authy — after your password."}
        </p>
      </div>

      {isError ? (
        <p className="text-xs text-destructive">Couldn't load your authenticators.</p>
      ) : null}

      {on ? (
        <>
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {devices.map((factor) => (
              <li key={factor.id}>
                <AuthenticatorRow factor={factor} last={devices.length === 1} />
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            There are no backup codes: a second device is the way back in if you lose this one. API
            keys you made keep working.
          </p>
        </>
      ) : null}

      <div className="flex justify-end border-t border-hairline pt-4">
        <Button
          variant={on ? "outline" : "default"}
          onClick={() => setAdding(true)}
          disabled={isPending || isError}
        >
          {on ? "Add another device" : "Set up"}
        </Button>
      </div>

      <AddAuthenticatorDialog open={adding} onOpenChange={setAdding} first={!on} />
    </SectionCard>
  );
}

function AuthenticatorRow({ factor, last }: { factor: Factor; last: boolean }) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const name = factor.friendly_name || "Authenticator";

  const remove = async () => {
    setRemoving(true);
    try {
      await removeAuthenticator(factor.id);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(last ? "Two-step sign-in is off" : "Device removed");
    } catch (cause) {
      toast.error(message(cause, "Couldn't remove that device"));
      setRemoving(false);
    }
  };

  return (
    <DataRow
      icon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline bg-surface">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
        </span>
      }
      title={name}
      meta={`added ${formatRelative(Date.parse(factor.created_at))}`}
      trailing={
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={removing} className="shrink-0">
              {removing ? "Removing…" : "Remove"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
              <AlertDialogDescription>
                {last
                  ? "It is your only one, so this turns two-step sign-in off: your password alone will get you in again."
                  : "Its codes stop working. Your other devices still do."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void remove()}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    />
  );
}

/**
 * Name the device, scan, confirm with a first code.
 *
 * Nothing counts until the code: the factor GoTrue creates on "Continue" is
 * unverified, and one left behind by closing the dialog is removed here and
 * swept again by the next `startEnrollment`.
 */
function AddAuthenticatorDialog({
  open,
  onOpenChange,
  first,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  first: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = code.replace(/\s/g, "");

  const reset = () => {
    setName("");
    setCode("");
    setEnrollment(null);
    setError(null);
  };

  const close = (v: boolean) => {
    if (!v && enrollment) void abandonEnrollment(enrollment.factorId).catch(() => {});
    onOpenChange(v);
    if (!v) reset();
  };

  const begin = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await startEnrollment(name.trim()));
    } catch (cause) {
      setError(message(cause, "Couldn't start setting that up"));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!enrollment || busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmEnrollment(enrollment.factorId, digits);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(first ? "Two-step sign-in is on" : "Device added");
      onOpenChange(false);
      reset();
    } catch (cause) {
      setError(message(cause, "That code did not match"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{enrollment ? "Scan this code" : "Add an authenticator"}</DialogTitle>
        </DialogHeader>

        {enrollment ? (
          <form
            method="post"
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
            className="space-y-4"
          >
            {/* GoTrue draws the QR code itself, as an SVG data URI: no library
                here, and no third party ever sees the secret. */}
            <img
              src={enrollment.qrCode}
              alt="QR code for your authenticator app"
              className="mx-auto h-44 w-44 rounded-lg bg-white p-2"
            />
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Can't scan it? Enter this key instead:
              </p>
              <p className="break-all font-mono text-xs">{enrollment.secret}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="enroll-code">Code from the app</Label>
              <Input
                id="enroll-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                placeholder="123 456"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setError(null);
                }}
                className="tracking-widest"
              />
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={busy || digits.length < 6}>
                {busy ? "Checking…" : first ? "Turn on" : "Add device"}
              </Button>
            </div>
          </form>
        ) : (
          <form
            method="post"
            onSubmit={(e) => {
              e.preventDefault();
              void begin();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="device-name">Device name</Label>
              <Input
                id="device-name"
                placeholder="Work phone"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
              <p className="text-xs text-muted-foreground">
                So you can tell your devices apart later.
              </p>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? "Starting…" : "Continue"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
